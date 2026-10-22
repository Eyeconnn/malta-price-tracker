// POST /api/reports: "Something wrong?" reports from visitors, the site's only public write path (Ruling R45).
// Checks in order: IP_SALT configured (else throw: generic 500), Origin (403), content-type (415), body size (413),
// JSON shape and fields (400), Turnstile when a secret is set (400), then the rate limit and insert (429 / 201).
// The rate limit bucket is the client IPv4 address, or the /64 of an IPv6 address (Ruling R47).
// Writes use the site_reporter role only (Ruling R7: insert on reports, select (ip_hash, created_at); no RETURNING).
// Responses are never cached.
import { neon } from '@neondatabase/serverless';
import type { Statement } from './data.js';
import type { Env } from './env.js';
import { json, readJsonWrite } from './http.js';

export const REPORT_TARGETS = ['product', 'shop', 'match'] as const;
export const REPORT_REASONS = ['wrong-price', 'wrong-match', 'not-black-friday', 'other'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];
export type ReportReason = (typeof REPORT_REASONS)[number];

/** The JSON body of POST /api/reports. targetId: products.id, shops.id or (match) the other row's site_products.id (R20). */
export type ReportBody = {
  targetType: ReportTarget;
  targetId: number;
  reason: ReportReason;
  message?: string;
  email?: string;
  turnstileToken?: string;
};

export const REPORTS_PER_HOUR = 5;
export const MESSAGE_MAX = 1000;
export const EMAIL_MAX = 254;
const BODY_MAX = 8 * 1024;
const TOKEN_MAX = 2048;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 5000;
/** First key of the per-IP advisory lock, so it cannot meet another feature's locks. */
const LOCK_CLASS = 4515;

/** A validated report, ready to insert. message and email are null when absent. */
export type NewReport = {
  targetType: ReportTarget;
  targetId: number;
  reason: ReportReason;
  message: string | null;
  email: string | null;
  ipHash: string;
};

export type InsertResult = { ok: true } | { ok: false; retryAfter: number };

export interface ReportStore {
  /** Inserts unless the ip hash already has `limit` reports in the last hour; retryAfter in seconds. */
  insertLimited(report: NewReport, limit: number): Promise<InsertResult>;
}

/** Runs statements in one read-write transaction. */
export interface WriteRunner {
  transaction(statements: Statement[]): Promise<Record<string, unknown>[][]>;
}

export interface ReportDeps {
  store: (env: Env) => ReportStore;
  /** fetch for Turnstile siteverify; defaults to the global fetch */
  fetch?: typeof fetch;
}

/**
 * One transaction: a per-IP advisory lock (so parallel requests from one client cannot all pass the count), the
 * count of the last hour, and an insert that only happens while the count is under the limit. Only ip_hash and
 * created_at are read, and the insert has no RETURNING (the role cannot select id).
 */
export function createReportStore(db: WriteRunner): ReportStore {
  return {
    async insertLimited(r, limit) {
      const window = `from reports where ip_hash = $1::text and created_at > now() - interval '1 hour'`;
      const [, counted] = await db.transaction([
        { text: `select pg_advisory_xact_lock(${LOCK_CLASS}, hashtext($1::text))`, params: [r.ipHash] },
        {
          text: `select count(*)::int as n, ceil(extract(epoch from (min(created_at) + interval '1 hour' - now())))::int as retry ${window}`,
          params: [r.ipHash],
        },
        {
          text: `insert into reports (target_type, target_id, reason, message, email, ip_hash)
            select $2::text, $3::bigint, $4::text, $5::text, $6::text, $1::text
            where (select count(*) ${window}) < $7::int`,
          params: [r.ipHash, r.targetType, r.targetId, r.reason, r.message, r.email, limit],
        },
      ]);
      const row = counted[0] ?? {};
      if (Number(row.n) < limit) return { ok: true };
      return { ok: false, retryAfter: Math.max(1, Number(row.retry) || 1) };
    },
  };
}

export function neonReportStore(databaseUrl: string): ReportStore {
  const sql = neon(databaseUrl);
  return createReportStore({
    // READ COMMITTED (stated, not left to the default): each statement takes a new snapshot, so the recount after
    // the advisory lock sees the rows the previous lock holder committed. Under REPEATABLE READ the snapshot of
    // the first statement would hide them and a parallel burst could pass the limit.
    transaction: (statements) =>
      sql.transaction(
        statements.map((s) => sql.query(s.text, s.params)),
        { isolationLevel: 'ReadCommitted' },
      ) as Promise<Record<string, unknown>[][]>,
  });
}

export const DEFAULT_REPORTS: ReportDeps = { store: (env) => neonReportStore(env.REPORTER_DATABASE_URL) };

const bad = (field: string) => json({ error: field }, 400);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Control characters other than tab and newline removed, lone surrogates replaced, trimmed; null when empty. */
export function cleanText(v: string): string | null {
  const s = v
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\uFFFD')
    .trim();
  return s === '' ? null : s;
}

/** An optional text field: absent, null or blank gives null; a non-string gives undefined (invalid). */
function optionalText(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  return cleanText(v);
}

type Valid = { report: Omit<NewReport, 'ipHash'>; token: string | null };

/** The report in a parsed body, or the name of the first bad field. Unknown keys are ignored. */
export function validateReport(body: unknown): Valid | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'body' };
  const b = body as Record<string, unknown>;
  if (!REPORT_TARGETS.includes(b.targetType as ReportTarget)) return { error: 'targetType' };
  if (typeof b.targetId !== 'number' || !Number.isSafeInteger(b.targetId) || b.targetId <= 0) return { error: 'targetId' };
  if (!REPORT_REASONS.includes(b.reason as ReportReason)) return { error: 'reason' };
  const message = optionalText(b.message);
  if (message === undefined || (message !== null && message.length > MESSAGE_MAX)) return { error: 'message' };
  const email = optionalText(b.email);
  if (email === undefined || (email !== null && (email.length > EMAIL_MAX || !EMAIL.test(email)))) return { error: 'email' };
  const token = optionalText(b.turnstileToken);
  if (token === undefined || (token !== null && token.length > TOKEN_MAX)) return { error: 'turnstileToken' };
  return {
    report: { targetType: b.targetType as ReportTarget, targetId: b.targetId, reason: b.reason as ReportReason, message, email },
    token,
  };
}

/** 16-bit groups of an IPv6 address (zone removed, '::' expanded, an IPv4 tail as two groups); null if malformed. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.split('%')[0]!;
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const b = v4.slice(2).map(Number);
    if (b.some((n) => n > 255)) return null;
    s = `${v4[1]}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h: string) => (h === '' ? [] : h.split(':'));
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The rate limit bucket of a client address (Ruling R47): IPv4 as is; IPv6 as its /64 (one client usually
 * controls a whole /64), normalised as four lowercase hextets plus '::/64'; IPv4-mapped IPv6 as the IPv4
 * address. Anything unparseable is its own bucket (lowercased); Cloudflare always sends a valid address.
 */
export function ipBucket(raw: string): string {
  const ip = raw.trim().toLowerCase();
  if (!ip.includes(':')) return ip;
  const g = ipv6Groups(ip);
  if (!g) return ip;
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join('.');
  return `${g.slice(0, 4).map((n) => n.toString(16)).join(':')}::/64`;
}

/** Lowercase hex SHA-256 of IP_SALT + the client's bucket (ipBucket). */
export async function ipHash(salt: string, bucket: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + bucket));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hostnames a Turnstile token may have been issued on: SITE_ORIGIN's and the request's own. */
function allowedHosts(env: Env, url: URL): string[] {
  const hosts = [url.hostname];
  try {
    hosts.push(new URL(env.SITE_ORIGIN).hostname);
  } catch {
    // SITE_ORIGIN unset or malformed
  }
  return hosts;
}

/**
 * True only when siteverify answers in time with success and a hostname of this site. Every failure (network,
 * timeout, HTTP error, non-JSON, wrong host) is false: the report is refused with 400, never stored.
 */
async function turnstileOk(secret: string, token: string, ip: string | null, hosts: string[], doFetch: typeof fetch): Promise<boolean> {
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set('remoteip', ip);
  try {
    const res = await doFetch(SITEVERIFY, { method: 'POST', body: form, signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS) });
    if (!res.ok) return false;
    const out = (await res.json()) as { success?: unknown; hostname?: unknown } | null;
    return out?.success === true && typeof out.hostname === 'string' && hosts.includes(out.hostname.toLowerCase());
  } catch (e) {
    console.error('turnstile siteverify failed', (e as Error).message);
    return false;
  }
}

/** Handles /api/reports (any method). */
export async function handleReport(req: Request, env: Env, url: URL, deps: ReportDeps): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
  // fail closed: without a salt the stored hashes would be plain hashes of IP addresses
  if (!env.IP_SALT) throw new Error('IP_SALT is not set');
  const read = await readJsonWrite(req, env, url, BODY_MAX);
  if ('response' in read) return read.response;
  const valid = validateReport(read.body);
  if ('error' in valid) return bad(valid.error);

  const ip = req.headers.get('cf-connecting-ip');
  if (env.TURNSTILE_SECRET) {
    if (!valid.token) return bad('turnstileToken');
    const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
    if (!(await turnstileOk(env.TURNSTILE_SECRET, valid.token, ip, allowedHosts(env, url), doFetch))) return bad('turnstileToken');
  }

  // no cf-connecting-ip only happens off Cloudflare (local dev): one shared bucket
  const hash = await ipHash(env.IP_SALT, ipBucket(ip || 'unknown'));
  const result = await deps.store(env).insertLimited({ ...valid.report, ipHash: hash }, REPORTS_PER_HOUR);
  if (!result.ok) return json({ error: 'rate limited' }, 429, { 'retry-after': String(result.retryAfter) });
  return json({ ok: true }, 201);
}
