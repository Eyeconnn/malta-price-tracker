// POST /api/shop-suggestions: a visitor suggests a shop on /shops (owner request 29 Oct 2026). The second public
// write path after reports.ts, with the same checks: IP_SALT set, Origin, JSON, body size, Turnstile when a
// secret is set, a per-network limit. Writes use the site_reporter role (migration 018: read the public columns
// of shops and shop_requests, insert a visitor request).
// A known address is answered at once: listed on the site, being checked, or why it cannot be tracked (a reason
// code, shown as fixed text: never the raw error or the owner's notes). A new address becomes a shop request with
// source 'visitor', checked by the PC task like the owner's; a shop that passes goes live on its own.
// The Worker never fetches the address (as for the admin form). Responses are never cached.
import { neon } from '@neondatabase/serverless';
import { NAME_MAX, cleanDisplayName, hostKey, parseShopAddress } from '../../src/shop-requests/address.js';
import { isUnavailableReason, REASON_TEXT, SCOPE_NOTE, type UnavailableReason } from '../../src/shop-requests/reasons.js';
import { MAX_QUEUED, QUEUED } from '../../src/shop-requests/statuses.js';
import type { Env } from './env.js';
import { json, readJsonWrite } from './http.js';
import { allowedHosts, ipBucket, ipHash, turnstileOk, type WriteRunner } from './reports.js';

/** New suggestions per network per day. */
export const SUGGESTIONS_PER_DAY = 3;
/** Visitor suggestions waiting or being checked at once, so they never fill the whole queue of MAX_QUEUED. */
export const MAX_VISITOR_QUEUED = 10;
const BODY_MAX = 4 * 1024;
const TOKEN_MAX = 2048;
/** First key of the per-network advisory lock (reports use 4515). */
const LOCK_CLASS = 4516;

export type SuggestionAnswer =
  /** on the site now */
  | { outcome: 'listed'; shop: { slug: string; name: string } }
  /** new: queued for the check (about 15 minutes) */
  | { outcome: 'queued' }
  /** a check is waiting or running */
  | { outcome: 'checking' }
  /** already on our list but not shown, with no reason to give (switched off for now, or hidden) */
  | { outcome: 'known' }
  | { outcome: 'unavailable'; reason: UnavailableReason; title: string; text: string; scope: string };

export type KnownShop = { slug: string; name: string; baseUrl: string; active: boolean; hidden: boolean; reason: string | null };
export type KnownRequest = { origin: string; status: string; reason: string | null };

export type InsertSuggestion = { ok: true } | { ok: false; limit: 'network'; retryAfter: number } | { ok: false; limit: 'queue' } | { ok: false; limit: 'duplicate' };

export interface SuggestionStore {
  /** every shop, and every request newest first */
  known(): Promise<{ shops: KnownShop[]; requests: KnownRequest[] }>;
  /** inserts a visitor request unless the network or the queue is at its limit; retryAfter in seconds */
  insert(s: { origin: string; name: string | null; ipHash: string }): Promise<InsertSuggestion>;
}

export interface SuggestionDeps {
  store: (env: Env) => SuggestionStore;
  /** fetch for Turnstile siteverify; defaults to the global fetch */
  fetch?: typeof fetch;
}

const unavailable = (reason: UnavailableReason): SuggestionAnswer => ({ outcome: 'unavailable', reason, ...REASON_TEXT[reason], scope: SCOPE_NOTE });

/**
 * What a visitor is told about a known host, or null when it is new. The shop comes first (live, or switched off
 * with a public reason), then its newest request (waiting, rejected, or not added and why); a shop on our list
 * with neither is 'known'. www. and the apex are one shop (hostKey).
 */
export function answerFor(host: string, shops: KnownShop[], requests: KnownRequest[]): SuggestionAnswer | null {
  const key = hostKey(host);
  const shop = shops.find((s) => hostKey(s.baseUrl) === key);
  if (shop?.active && !shop.hidden) return { outcome: 'listed', shop: { slug: shop.slug, name: shop.name } };
  if (shop && isUnavailableReason(shop.reason)) return unavailable(shop.reason);
  const req = requests.find((r) => hostKey(r.origin) === key);
  if (req) {
    if ((QUEUED as readonly string[]).includes(req.status)) return { outcome: 'checking' };
    if (req.status === 'rejected') return unavailable('declined');
    if (isUnavailableReason(req.reason)) return unavailable(req.reason);
  }
  return shop || req ? { outcome: 'known' } : null;
}

export function createSuggestionStore(db: WriteRunner): SuggestionStore {
  return {
    async known() {
      const [shops, requests] = await db.transaction([
        { text: 'select slug, name, base_url, active, site_hidden, unavailable_reason from shops', params: [] },
        { text: 'select origin, status, reason from shop_requests order by requested_at desc, id desc', params: [] },
      ]);
      return {
        shops: shops!.map((r) => ({
          slug: String(r.slug),
          name: String(r.name),
          baseUrl: String(r.base_url),
          active: Boolean(r.active),
          hidden: Boolean(r.site_hidden),
          reason: typeof r.unavailable_reason === 'string' ? r.unavailable_reason : null,
        })),
        requests: requests!.map((r) => ({ origin: String(r.origin), status: String(r.status), reason: typeof r.reason === 'string' ? r.reason : null })),
      };
    },

    // One transaction: a per-network advisory lock (parallel requests from one client cannot all pass the count),
    // the counts, and an insert that only happens while every count is under its limit. No RETURNING: the role
    // reads only the public columns.
    async insert({ origin, name, ipHash: hash }) {
      const day = `from shop_requests where source = 'visitor' and ip_hash = $1::text and requested_at > now() - interval '1 day'`;
      const open = `from shop_requests where status = any($2::text[])`;
      try {
        const [, counted] = await db.transaction([
          { text: `select pg_advisory_xact_lock(${LOCK_CLASS}, hashtext($1::text))`, params: [hash] },
          {
            text: `select (select count(*) ${day})::int as mine,
                (select ceil(extract(epoch from (min(requested_at) + interval '1 day' - now()))) ${day})::int as retry,
                (select count(*) ${open} and source = 'visitor')::int as visitors,
                (select count(*) ${open})::int as queued`,
            params: [hash, [...QUEUED]],
          },
          {
            text: `insert into shop_requests (origin, display_name, source, ip_hash)
              select $3::text, $4::text, 'visitor', $1::text
              where (select count(*) ${day}) < $5::int
                and (select count(*) ${open} and source = 'visitor') < $6::int
                and (select count(*) ${open}) < $7::int`,
            params: [hash, [...QUEUED], origin, name, SUGGESTIONS_PER_DAY, MAX_VISITOR_QUEUED, MAX_QUEUED],
          },
        ]);
        const row = counted![0] ?? {};
        if (Number(row.mine) >= SUGGESTIONS_PER_DAY) return { ok: false, limit: 'network', retryAfter: Math.max(1, Number(row.retry) || 1) };
        if (Number(row.visitors) >= MAX_VISITOR_QUEUED || Number(row.queued) >= MAX_QUEUED) return { ok: false, limit: 'queue' };
        return { ok: true };
      } catch (e) {
        // the open-origin unique index: the same shop was suggested a moment ago
        if ((e as { code?: string }).code === '23505') return { ok: false, limit: 'duplicate' };
        throw e;
      }
    },
  };
}

export function neonSuggestionStore(databaseUrl: string): SuggestionStore {
  const sql = neon(databaseUrl);
  return createSuggestionStore({
    // READ COMMITTED, as for reports: the recount after the advisory lock sees what the previous holder committed
    transaction: (statements) =>
      sql.transaction(
        statements.map((s) => sql.query(s.text, s.params)),
        { isolationLevel: 'ReadCommitted' },
      ) as Promise<Record<string, unknown>[][]>,
  });
}

export const DEFAULT_SUGGESTIONS: SuggestionDeps = { store: (env) => neonSuggestionStore(env.REPORTER_DATABASE_URL) };

const bad = (field: string, extra: Record<string, unknown> = {}) => json({ error: field, ...extra }, 400);

/** Handles /api/shop-suggestions (any method). */
export async function handleSuggestion(req: Request, env: Env, url: URL, deps: SuggestionDeps): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
  // fail closed: without a salt the stored hashes would be plain hashes of IP addresses
  if (!env.IP_SALT) throw new Error('IP_SALT is not set');
  const read = await readJsonWrite(req, env, url, BODY_MAX);
  if ('response' in read) return read.response;
  const b = read.body;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('body');
  const { url: raw, name: rawName, turnstileToken } = b as Record<string, unknown>;
  if (typeof raw !== 'string') return bad('url', { reason: 'empty' });
  const address = parseShopAddress(raw);
  if (!address.ok) return bad('url', { reason: address.problem });
  if (rawName !== undefined && rawName !== null && typeof rawName !== 'string') return bad('name');
  const name = cleanDisplayName(rawName as string | null | undefined);
  if (name !== null && name.length > NAME_MAX) return bad('name');
  if (turnstileToken !== undefined && turnstileToken !== null && (typeof turnstileToken !== 'string' || turnstileToken.length > TOKEN_MAX)) return bad('turnstileToken');

  const ip = req.headers.get('cf-connecting-ip');
  if (env.TURNSTILE_SECRET) {
    if (!turnstileToken) return bad('turnstileToken');
    const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
    if (!(await turnstileOk(env.TURNSTILE_SECRET, turnstileToken as string, ip, allowedHosts(env, url), doFetch))) return bad('turnstileToken');
  }

  const store = deps.store(env);
  const { shops, requests } = await store.known();
  const known = answerFor(address.host, shops, requests);
  if (known) return json(known);

  // no cf-connecting-ip only happens off Cloudflare (local dev): one shared bucket
  const hash = await ipHash(env.IP_SALT, ipBucket(ip || 'unknown'));
  const out = await store.insert({ origin: address.origin, name, ipHash: hash });
  if (out.ok) return json({ outcome: 'queued' } satisfies SuggestionAnswer, 201);
  if (out.limit === 'duplicate') return json({ outcome: 'checking' } satisfies SuggestionAnswer);
  if (out.limit === 'network') return json({ error: 'rate limited' }, 429, { 'retry-after': String(out.retryAfter) });
  return json({ error: 'queue full' }, 503);
}
