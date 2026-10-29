// Shop requests for the admin "Add shop" page: list, add an address, retry or reject. Routed from admin.ts after
// its requireAdmin check, writes through readJsonWrite (same Origin, JSON, size cap), SQL as site_admin.
// The Worker never fetches the submitted address: it only checks its form and stores the origin. The PC task
// (pnpm shop-requests) does the fetching, through safeFetch, which refuses private addresses at connection time.
// Stored JSON (robots, sample, details) is written by the PC task from fetched pages, so it is reshaped here
// into known fields before it leaves the Worker; the page shows it as text only.
import { z } from 'zod';
import { NAME_MAX, SHOP_CATEGORIES, cleanDisplayName, hostKey, parseShopAddress } from '../../src/shop-requests/address.js';
import { MAX_QUEUED, QUEUED, REJECT_FROM, RETRY_FROM, type ShopRequestStatus } from '../../src/shop-requests/statuses.js';
import type { AdminRunner } from './admin.js';
import type { Env } from './env.js';
import { json, readJsonWrite } from './http.js';

export type RobotsView = {
  status: string;
  allowed: boolean;
  crawlDelaySeconds: number;
  blockedBy: { path: string; rule: string } | null;
};
export type SampleView = { title: string | null; priceCents: number | null; url: string | null };
export type DetailsView = {
  server: string | null;
  poweredBy: string | null;
  generator: string[];
  jsonLdProduct: boolean | null;
  productPagesChecked: string[];
  categoryLinks: string[];
  disallowed: { feed: string; path: string; rule: string }[];
};

export type AdminShopRequest = {
  id: number;
  origin: string;
  name: string | null;
  category: string | null;
  status: ShopRequestStatus;
  requestedAt: string;
  startedAt: string | null;
  checkedAt: string | null;
  platform: string | null;
  robots: RobotsView | null;
  productsFound: number | null;
  sample: SampleView[];
  details: DetailsView | null;
  error: string | null;
  attempts: number;
  /** a request rate limited by the shop waits until then before it is checked again */
  nextCheckAt: string | null;
  /** admin: added on this page; visitor: suggested on the public Shops page */
  source: 'admin' | 'visitor';
  /** the shop this request created, with its stored name; null until a supported shop was saved */
  shop: { slug: string; name: string; active: boolean } | null;
};

export type CreateResult =
  | { request: AdminShopRequest }
  /** active: the shop is scraped every night; a switched-off one carries its note (why it is off), null when none */
  | { duplicate: 'shop'; slug: string; active: boolean; note: string | null }
  | { duplicate: 'request'; status: ShopRequestStatus }
  | { full: true };

export interface ShopRequestStore {
  /** newest first, at most 200 */
  shopRequests(): Promise<AdminShopRequest[]>;
  createShopRequest(input: { origin: string; host: string; name: string | null; category: string | null }): Promise<CreateResult>;
  /** null: no such request; 'conflict': its current status is not in `from`; 'full': a retry over the open cap */
  setShopRequestStatus(id: number, status: 'pending' | 'rejected', from: readonly ShopRequestStatus[]): Promise<AdminShopRequest | 'conflict' | 'full' | null>;
}

type Row = Record<string, unknown>;
const LIST_MAX = 200;
const TEXT_MAX = 500;
/** The longest note of a switched-off shop sent back to the Add shop form. */
const NOTE_MAX = 300;

// ---------------------------------------------------------------- reshaping stored JSON

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = TEXT_MAX): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
const strList = (v: unknown, n: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, n).map((x) => x.slice(0, 200)) : []);
const parsed = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return null;
  }
};

function robotsView(raw: unknown): RobotsView | null {
  const v = parsed(raw);
  if (!isObj(v) || typeof v.allowed !== 'boolean') return null;
  const b = v.blockedBy;
  return {
    status: str(v.status, 20) ?? 'ok',
    allowed: v.allowed,
    crawlDelaySeconds: typeof v.crawlDelaySeconds === 'number' && Number.isFinite(v.crawlDelaySeconds) ? v.crawlDelaySeconds : 0,
    blockedBy: isObj(b) && typeof b.path === 'string' && typeof b.rule === 'string' ? { path: b.path.slice(0, 200), rule: b.rule.slice(0, 300) } : null,
  };
}

function sampleView(raw: unknown): SampleView[] {
  const v = parsed(raw);
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .slice(0, 10)
    .map((s) => ({
      title: str(s.title, 200),
      priceCents: typeof s.priceCents === 'number' && Number.isInteger(s.priceCents) ? s.priceCents : null,
      url: str(s.url),
    }));
}

function detailsView(raw: unknown): DetailsView | null {
  const v = parsed(raw);
  if (!isObj(v)) return null;
  return {
    server: str(v.server, 100),
    poweredBy: str(v.poweredBy, 100),
    generator: strList(v.generator, 5),
    jsonLdProduct: typeof v.jsonLdProduct === 'boolean' ? v.jsonLdProduct : null,
    productPagesChecked: strList(v.productPagesChecked, 5),
    categoryLinks: strList(v.categoryLinks, 5),
    disallowed: Array.isArray(v.disallowed)
      ? v.disallowed
          .filter(isObj)
          .slice(0, 5)
          .map((d) => ({ feed: str(d.feed, 50) ?? '', path: str(d.path, 200) ?? '', rule: str(d.rule, 300) ?? '' }))
      : [],
  };
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const SELECT = `select r.id, r.origin, r.display_name, r.shop_category, r.status, r.requested_at, r.started_at, r.checked_at,
    r.platform, r.robots, r.products_found, r.sample, r.details, r.error, r.attempts, r.next_check_at, r.source,
    s.slug as shop_slug, s.name as shop_name, s.active as shop_active
  from shop_requests r left join shops s on s.id = r.shop_id`;

function toRequest(r: Row): AdminShopRequest {
  return {
    id: Number(r.id),
    origin: String(r.origin),
    name: str(r.display_name, NAME_MAX),
    category: str(r.shop_category, 40),
    status: r.status as ShopRequestStatus,
    requestedAt: iso(r.requested_at)!,
    startedAt: iso(r.started_at),
    checkedAt: iso(r.checked_at),
    platform: str(r.platform, 40),
    robots: robotsView(r.robots),
    productsFound: numOrNull(r.products_found),
    sample: sampleView(r.sample),
    details: detailsView(r.details),
    error: str(r.error),
    attempts: Number(r.attempts ?? 0),
    nextCheckAt: iso(r.next_check_at),
    source: r.source === 'visitor' ? 'visitor' : 'admin',
    shop:
      r.shop_slug === null || r.shop_slug === undefined
        ? null
        : { slug: String(r.shop_slug), name: str(r.shop_name, NAME_MAX) ?? String(r.shop_slug), active: Boolean(r.shop_active) },
  };
}

// ---------------------------------------------------------------- store

export function shopRequestStore(db: AdminRunner): ShopRequestStore {
  return {
    async shopRequests() {
      const rows = await db.query(`${SELECT} order by r.requested_at desc, r.id desc limit $1::int`, [LIST_MAX]);
      return rows.map(toRequest);
    },

    async createShopRequest({ origin, host, name, category }) {
      const [shops, open] = await db.transaction([
        { text: 'select slug, base_url, active, notes from shops', params: [] },
        { text: `select origin, status from shop_requests where status <> 'rejected'`, params: [] },
      ]);
      const key = hostKey(host);
      const shop = shops!.find((s) => hostKey(String(s.base_url)) === key);
      if (shop) {
        const active = Boolean(shop.active);
        const note = typeof shop.notes === 'string' ? shop.notes.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) : '';
        return { duplicate: 'shop', slug: String(shop.slug), active, note: active || note === '' ? null : note };
      }
      const req = open!.find((r) => hostKey(String(r.origin)) === key);
      if (req) return { duplicate: 'request', status: req.status as ShopRequestStatus };
      let rows: Row[];
      try {
        rows = await db.query(
          `with ins as (
             insert into shop_requests (origin, display_name, shop_category)
             select $1::text, $2::text, $3::text
             where (select count(*) from shop_requests where status = any($4::text[])) < $5::int
             returning *)
           select ins.*, null::text as shop_slug, null::boolean as shop_active from ins`,
          [origin, name, category, [...QUEUED], MAX_QUEUED],
        );
      } catch (e) {
        // the open-origin unique index: the same address was added a moment ago
        if ((e as { code?: string }).code === '23505') return { duplicate: 'request', status: 'pending' };
        throw e;
      }
      return rows[0] ? { request: toRequest(rows[0]) } : { full: true };
    },

    async setShopRequestStatus(id, status, from) {
      // a retry adds to the open checks, so the cap is part of the update itself
      const [updated, rows] = await db.transaction([
        {
          text: `update shop_requests set status = $2::text
            where id = $1::bigint and status = any($3::text[])
              and ($2::text <> 'pending' or (select count(*) from shop_requests where status = any($4::text[])) < $5::int)
            returning id`,
          params: [id, status, [...from], [...QUEUED], MAX_QUEUED],
        },
        { text: `${SELECT} where r.id = $1::bigint`, params: [id] },
      ]);
      const row = rows![0];
      if (!row) return null;
      if (updated!.length) return toRequest(row);
      return status === 'pending' && from.includes(row.status as ShopRequestStatus) ? 'full' : 'conflict';
    },
  };
}

// ---------------------------------------------------------------- routes

const BODY_MAX = 8 * 1024;
const ID = /^\d{1,15}$/;

const createSchema = z.strictObject({
  url: z.string(),
  name: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
});
const patchSchema = z.strictObject({ status: z.enum(['pending', 'rejected']) });

const invalid = (field: string, extra: Record<string, unknown> = {}) => json({ error: 'invalid', field, ...extra }, 400);
const notAllowed = (allow: string) => json({ error: 'method not allowed' }, 405, { allow });

/** Handles /api/admin/shop-requests and /api/admin/shop-requests/:id; null for any other path. Auth is already checked. */
export async function handleShopRequests(req: Request, env: Env, url: URL, store: () => ShopRequestStore): Promise<Response | null> {
  const p = url.pathname;
  if (p === '/api/admin/shop-requests') {
    if (req.method === 'GET') return json({ requests: await store().shopRequests(), maxQueued: MAX_QUEUED });
    if (req.method !== 'POST') return notAllowed('GET, POST');
    const read = await readJsonWrite(req, env, url, BODY_MAX);
    if ('response' in read) return read.response;
    const body = createSchema.safeParse(read.body);
    if (!body.success) return invalid((body.error.issues[0]?.path ?? []).map(String).join('.'));
    const address = parseShopAddress(body.data.url);
    if (!address.ok) return invalid('url', { reason: address.problem });
    const name = cleanDisplayName(body.data.name);
    if (name !== null && name.length > NAME_MAX) return invalid('name');
    const category = body.data.category ? body.data.category : null;
    if (category !== null && !(SHOP_CATEGORIES as readonly string[]).includes(category)) return invalid('category');

    const out = await store().createShopRequest({ origin: address.origin, host: address.host, name, category });
    if ('full' in out) return json({ error: 'too many pending', max: MAX_QUEUED }, 429);
    if ('duplicate' in out) {
      return json(
        out.duplicate === 'shop'
          ? { error: 'duplicate', field: 'url', reason: 'shop', slug: out.slug, active: out.active, note: out.note }
          : { error: 'duplicate', field: 'url', reason: 'request', status: out.status },
        409,
      );
    }
    return json({ request: out.request }, 201);
  }

  const one = /^\/api\/admin\/shop-requests\/([^/]+)$/.exec(p);
  if (!one) return null;
  if (!ID.test(one[1]!)) return json({ error: 'not found' }, 404);
  if (req.method !== 'PATCH') return notAllowed('PATCH');
  const read = await readJsonWrite(req, env, url, BODY_MAX);
  if ('response' in read) return read.response;
  const body = patchSchema.safeParse(read.body);
  if (!body.success) return invalid((body.error.issues[0]?.path ?? []).map(String).join('.'));
  const from = body.data.status === 'pending' ? RETRY_FROM : REJECT_FROM;
  const out = await store().setShopRequestStatus(Number(one[1]), body.data.status, from);
  if (out === null) return json({ error: 'not found' }, 404);
  if (out === 'conflict') return json({ error: 'conflict' }, 409);
  if (out === 'full') return json({ error: 'too many pending', max: MAX_QUEUED }, 429);
  return json({ request: out });
}
