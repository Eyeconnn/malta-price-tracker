// Admin API under /api/admin/*: settings (public switch, phrases, thresholds, category overrides), report triage,
// hiding shops, confirming title matches and shop requests (Add shop page, shop-requests.ts). index.ts already
// required ADMIN_PASSWORD for these paths; every request here checks it again (Ruling R26), so the handler is safe
// even if it is ever reached another way. SQL runs only with the site_admin role (Env.ADMIN_DATABASE_URL, Rulings
// R7/R48). Responses are never cached; writes (PUT/PATCH/POST) need the site's Origin and application/json
// (Ruling R45). Store errors become the generic 500.
import { neon } from '@neondatabase/serverless';
import { z } from 'zod';
import { SITE_CATEGORIES } from '../../src/site/categories.js';
import {
  OVERRIDES_MAX,
  PHRASES_PER_SLOT_MAX,
  type PhraseSlot,
  type SiteSettings,
  THRESHOLD_LIMITS,
  type Thresholds,
  overrideKeyProblem,
  phraseProblem,
  settingsFromRows,
} from '../../src/site/settings.js';
import { requireAdmin } from './auth.js';
import type { Statement } from './data.js';
import type { Env } from './env.js';
import { json, readJsonWrite } from './http.js';
import { MESSAGE_MAX, cleanText } from './reports.js';
import { resetSiteSettingsCache } from './settings.js';
import { type ShopRequestStore, handleShopRequests, shopRequestStore } from './shop-requests.js';

export const REPORT_STATUSES = ['open', 'fixed', 'kept', 'hidden'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const ADMIN_PAGE_SIZE = 50;
const MAX_PAGE = 10_000;
/** Settings bodies: 150 phrases and 500 overrides fit easily. */
const BODY_MAX = 256 * 1024;
const PATCH_BODY_MAX = 8 * 1024;
const SLUG = /^[a-z0-9-]{1,64}$/;
const ID = /^\d{1,15}$/;

// ---------------------------------------------------------------- validation

function threshold(key: keyof Thresholds) {
  const { min, max, integer } = THRESHOLD_LIMITS[key];
  const n = z.number().min(min).max(max);
  return integer ? n.int() : n;
}

function phraseList(slot: PhraseSlot) {
  const phrase = z
    .string()
    .refine((v) => phraseProblem(v, slot) === null)
    .transform((v) => v.trim());
  return z.array(phrase).min(1).max(PHRASES_PER_SLOT_MAX);
}

const SLUGS = SITE_CATEGORIES.map((c) => c.slug) as [string, ...string[]];

/** The whole SiteSettings document as PUT by the admin: every key required, unknown keys rejected. */
export const settingsSchema = z.strictObject({
  public: z.boolean(),
  thresholds: z.strictObject({
    minHistoryDays: threshold('minHistoryDays'),
    baselineDays: threshold('baselineDays'),
    raiseWindowDays: threshold('raiseWindowDays'),
    raisePct: threshold('raisePct'),
    goodDropPct: threshold('goodDropPct'),
    cheaperPct: threshold('cheaperPct'),
    minJudgedForRating: threshold('minJudgedForRating'),
  }),
  phrases: z.strictObject({
    morning: phraseList('morning'),
    afternoon: phraseList('afternoon'),
    evening: phraseList('evening'),
    late: phraseList('late'),
    bfweek: phraseList('bfweek'),
  }),
  categoryOverrides: z
    .record(
      z.string().refine((k) => overrideKeyProblem(k) === null && k !== '__proto__'),
      z.enum(SLUGS),
    )
    .refine((o) => Object.keys(o).length <= OVERRIDES_MAX),
}) satisfies z.ZodType<SiteSettings>;

const reportPatchSchema = z.strictObject({
  status: z.enum(REPORT_STATUSES),
  /** absent: keep the note; null or blank: clear it */
  adminNote: z.string().nullable().optional(),
});
const shopPatchSchema = z.strictObject({ hidden: z.boolean() });
const matchPatchSchema = z.strictObject({ confirmed: z.boolean() });

/** 400 naming the first invalid field (a dotted path), so the admin page can point at it. */
function invalid(error: z.ZodError): Response {
  const p = error.issues[0]?.path ?? [];
  return json({ error: 'invalid', field: p.map(String).join('.') }, 400);
}

// ---------------------------------------------------------------- store

export type AdminReport = {
  id: number;
  targetType: string;
  /** products.id, shops.id or site_products.id (Ruling R20) */
  targetId: number;
  /** where the target is on the site, and its title or shop name; null when it no longer exists */
  target: { link: string | null; label: string | null };
  reason: string | null;
  message: string | null;
  email: string | null;
  status: ReportStatus;
  adminNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
};
export type AdminShop = { slug: string; name: string; active: boolean; hidden: boolean; products: number };
export type MatchMember = { id: number; title: string; shop: string; shopSlug: string; priceCents: number | null; confirmed: boolean };
export type MatchGroup = { canonicalId: number; members: MatchMember[] };
export type UnmappedCategory = { path: string; count: number };

/** shopRequests, createShopRequest, setShopRequestStatus come from ShopRequestStore (shop-requests.ts) */
export interface AdminStore extends ShopRequestStore {
  settingsRows(): Promise<{ key: string; value: unknown }[]>;
  /** one upserted row per top-level key, in one transaction */
  saveSettings(s: SiteSettings): Promise<void>;
  /** newest first */
  reports(status: ReportStatus, limit: number, offset: number): Promise<{ items: AdminReport[]; total: number }>;
  /** note undefined keeps the stored note; null when the report does not exist */
  updateReport(id: number, status: ReportStatus, note: string | null | undefined): Promise<AdminReport | null>;
  /** every shop, by name */
  shops(): Promise<AdminShop[]>;
  setShopHidden(slug: string, hidden: boolean): Promise<{ slug: string; hidden: boolean } | null>;
  /** canonical groups matched by title; pendingOnly: only groups with an unconfirmed member */
  matches(pendingOnly: boolean, limit: number, offset: number): Promise<{ groups: MatchGroup[]; total: number }>;
  /** title-matched rows only; null for any other row (Ruling R50: a confirmation belongs to the row in its group) */
  confirmMatch(siteProductId: number, confirmed: boolean): Promise<{ id: number; confirmed: boolean } | null>;
  /** the 50 most common shop category paths (products.category_path) among site_products in category 'other' */
  unmappedCategories(): Promise<UnmappedCategory[]>;
}

type Row = Record<string, unknown>;

/** Runs SQL with $n parameters as site_admin; transaction runs the statements in one read-write transaction. */
export interface AdminRunner {
  query(text: string, params: unknown[]): Promise<Row[]>;
  transaction(statements: Statement[]): Promise<Row[][]>;
}

const SETTING_KEYS = ['public', 'thresholds', 'phrases', 'categoryOverrides'] as const;
const UNMAPPED_MAX = 50;

const num = (v: unknown): number => Number(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());

/** A report with its target resolved: a product report's products.id leads to its current site_products row. */
const REPORT_SELECT = `
  select r.id, r.target_type, r.target_id, r.reason, r.message, r.email, r.status, r.admin_note, r.created_at, r.resolved_at,
    case r.target_type when 'product' then psp.id when 'match' then msp.id end as product_link,
    case r.target_type when 'product' then coalesce(psp.title, p.title) when 'match' then msp.title when 'shop' then s.name end as label,
    case when r.target_type = 'shop' then s.slug end as shop_link
  from reports r
  left join products p on r.target_type = 'product' and p.id = r.target_id
  left join site_products psp on psp.shop_id = p.shop_id and psp.group_key = coalesce(p.parent_external_id, p.external_id)
  left join shops s on r.target_type = 'shop' and s.id = r.target_id
  left join site_products msp on r.target_type = 'match' and msp.id = r.target_id`;

function toReport(r: Row): AdminReport {
  const productLink = strOrNull(r.product_link);
  const shopLink = strOrNull(r.shop_link);
  return {
    id: num(r.id),
    targetType: String(r.target_type),
    targetId: num(r.target_id),
    target: {
      // the product page with that listing marked (/p/:id still redirects there)
      link: productLink !== null ? `/product/s${productLink}?seller=${productLink}` : shopLink !== null ? `/shops/${encodeURIComponent(shopLink)}` : null,
      label: strOrNull(r.label),
    },
    reason: strOrNull(r.reason),
    message: strOrNull(r.message),
    email: strOrNull(r.email),
    status: r.status as ReportStatus,
    adminNote: strOrNull(r.admin_note),
    createdAt: isoOrNull(r.created_at)!,
    resolvedAt: isoOrNull(r.resolved_at),
  };
}

export function createAdminStore(db: AdminRunner): AdminStore {
  return {
    ...shopRequestStore(db),

    async settingsRows() {
      const rows = await db.query('select key, value from site_settings', []);
      return rows.map((r) => ({ key: String(r.key), value: r.value }));
    },

    async saveSettings(s) {
      await db.transaction(
        SETTING_KEYS.map((key) => ({
          text: `insert into site_settings (key, value, updated_at) values ($1::text, $2::jsonb, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`,
          params: [key, JSON.stringify(s[key])],
        })),
      );
    },

    async reports(status, limit, offset) {
      const [rows, counted] = await db.transaction([
        { text: `${REPORT_SELECT} where r.status = $1::text order by r.created_at desc, r.id desc limit $2::int offset $3::int`, params: [status, limit, offset] },
        { text: 'select count(*)::int as n from reports where status = $1::text', params: [status] },
      ]);
      return { items: rows!.map(toReport), total: num(counted![0]?.n ?? 0) };
    },

    async updateReport(id, status, note) {
      // resolved_at: now() when closed, null when reopened, kept when only the note of a closed report changes
      const [updated, rows] = await db.transaction([
        {
          text: `update reports set status = $2::text,
              admin_note = case when $4::boolean then $3::text else admin_note end,
              resolved_at = case when $2::text = 'open' then null
                when status = $2::text and resolved_at is not null then resolved_at else now() end
            where id = $1::bigint returning id`,
          params: [id, status, note ?? null, note !== undefined],
        },
        { text: `${REPORT_SELECT} where r.id = $1::bigint`, params: [id] },
      ]);
      return updated!.length > 0 && rows![0] ? toReport(rows![0]) : null;
    },

    async shops() {
      const rows = await db.query(
        `select s.slug, s.name, s.active, s.site_hidden,
           (select count(*) from site_products sp where sp.shop_id = s.id)::int as products
         from shops s order by s.name, s.slug`,
        [],
      );
      return rows.map((r) => ({ slug: String(r.slug), name: String(r.name), active: Boolean(r.active), hidden: Boolean(r.site_hidden), products: num(r.products) }));
    },

    async setShopHidden(slug, hidden) {
      const rows = await db.query('update shops set site_hidden = $2::boolean where slug = $1::text returning slug, site_hidden', [slug, hidden]);
      return rows[0] ? { slug: String(rows[0].slug), hidden: Boolean(rows[0].site_hidden) } : null;
    },

    async matches(pendingOnly, limit, offset) {
      const groups = `select canonical_id from site_products
        where match_method = 'title' and canonical_id is not null
        group by canonical_id
        having not $1::boolean or bool_or(not match_confirmed)`;
      const [rows, counted] = await db.transaction([
        {
          text: `with g as (${groups} order by canonical_id limit $2::int offset $3::int)
            select sp.id, sp.canonical_id, sp.title, sp.price_cents, sp.match_confirmed, s.name as shop, s.slug as shop_slug
            from g join site_products sp on sp.canonical_id = g.canonical_id and sp.match_method = 'title'
            join shops s on s.id = sp.shop_id
            order by sp.canonical_id, sp.id`,
          params: [pendingOnly, limit, offset],
        },
        { text: `select count(*)::int as n from (${groups}) g`, params: [pendingOnly] },
      ]);
      const byGroup = new Map<number, MatchGroup>();
      for (const r of rows!) {
        const cid = num(r.canonical_id);
        let g = byGroup.get(cid);
        if (!g) byGroup.set(cid, (g = { canonicalId: cid, members: [] }));
        const price = r.price_cents === null || r.price_cents === undefined ? null : num(r.price_cents);
        g.members.push({
          id: num(r.id),
          title: String(r.title),
          shop: String(r.shop),
          shopSlug: String(r.shop_slug),
          priceCents: price !== null && price > 0 ? price : null,
          confirmed: Boolean(r.match_confirmed),
        });
      }
      return { groups: [...byGroup.values()], total: num(counted![0]?.n ?? 0) };
    },

    async confirmMatch(siteProductId, confirmed) {
      const rows = await db.query(`update site_products set match_confirmed = $2::boolean where id = $1::bigint and match_method = 'title' returning id, match_confirmed`, [
        siteProductId,
        confirmed,
      ]);
      return rows[0] ? { id: num(rows[0].id), confirmed: Boolean(rows[0].match_confirmed) } : null;
    },

    async unmappedCategories() {
      const rows = await db.query(
        `select p.category_path as path, count(*)::int as count
         from site_products sp join products p on p.id = sp.rep_product_id
         where sp.category = 'other' and nullif(btrim(p.category_path), '') is not null
         group by p.category_path
         order by count desc, path
         limit $1::int`,
        [UNMAPPED_MAX],
      );
      return rows.map((r) => ({ path: String(r.path), count: num(r.count) }));
    },
  };
}

export function neonAdminStore(databaseUrl: string): AdminStore {
  const sql = neon(databaseUrl);
  return createAdminStore({
    query: (text, params) => sql.query(text, params) as Promise<Row[]>,
    transaction: (statements) =>
      sql.transaction(
        statements.map((s) => sql.query(s.text, s.params)),
        { isolationLevel: 'ReadCommitted' },
      ) as Promise<Row[][]>,
  });
}

export interface AdminDeps {
  store: (env: Env) => AdminStore;
  /** forget the cached AccessSettings after a settings save; defaults to this isolate's cache reset */
  invalidateSettings?: () => void;
}

export const DEFAULT_ADMIN: AdminDeps = { store: (env) => neonAdminStore(env.ADMIN_DATABASE_URL) };

// ---------------------------------------------------------------- routes

const notFound = () => json({ error: 'not found' }, 404);
const notAllowed = (allow: string) => json({ error: 'method not allowed' }, 405, { allow });

/** page query parameter: 1 when absent, null when malformed or out of range */
function pageParam(url: URL): number | null {
  const raw = url.searchParams.get('page');
  if (raw === null) return 1;
  if (!/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_PAGE ? n : null;
}

async function readPatch<T>(req: Request, env: Env, url: URL, schema: z.ZodType<T>): Promise<{ value: T } | { response: Response }> {
  const read = await readJsonWrite(req, env, url, PATCH_BODY_MAX);
  if ('response' in read) return read;
  const parsed = schema.safeParse(read.body);
  return parsed.success ? { value: parsed.data } : { response: invalid(parsed.error) };
}

/** Handles /api/admin and /api/admin/* (any method). */
export async function handleAdmin(req: Request, env: Env, url: URL, deps: AdminDeps): Promise<Response> {
  const denied = await requireAdmin(req, env);
  if (denied) return denied;

  const p = url.pathname;
  const store = () => deps.store(env);

  const shopRequests = await handleShopRequests(req, env, url, store);
  if (shopRequests) return shopRequests;

  if (p === '/api/admin/settings') {
    if (req.method === 'GET') return json({ settings: settingsFromRows(await store().settingsRows()) });
    if (req.method !== 'PUT') return notAllowed('GET, PUT');
    const read = await readJsonWrite(req, env, url, BODY_MAX);
    if ('response' in read) return read.response;
    const parsed = settingsSchema.safeParse(read.body);
    if (!parsed.success) return invalid(parsed.error);
    await store().saveSettings(parsed.data);
    (deps.invalidateSettings ?? resetSiteSettingsCache)();
    return json({ settings: parsed.data });
  }

  if (p === '/api/admin/categories') {
    if (req.method !== 'GET') return notAllowed('GET');
    return json({ unmapped: await store().unmappedCategories() });
  }

  if (p === '/api/admin/reports') {
    if (req.method !== 'GET') return notAllowed('GET');
    const status = url.searchParams.get('status') ?? 'open';
    if (!REPORT_STATUSES.includes(status as ReportStatus)) return json({ error: 'bad status' }, 400);
    const page = pageParam(url);
    if (page === null) return json({ error: 'bad page' }, 400);
    const { items, total } = await store().reports(status as ReportStatus, ADMIN_PAGE_SIZE, (page - 1) * ADMIN_PAGE_SIZE);
    return json({ items, total, page, pageSize: ADMIN_PAGE_SIZE });
  }

  if (p === '/api/admin/shops') {
    if (req.method !== 'GET') return notAllowed('GET');
    return json({ shops: await store().shops() });
  }

  if (p === '/api/admin/matches') {
    if (req.method !== 'GET') return notAllowed('GET');
    const pending = url.searchParams.get('pending');
    if (pending !== null && pending !== '0' && pending !== '1') return json({ error: 'bad pending' }, 400);
    const page = pageParam(url);
    if (page === null) return json({ error: 'bad page' }, 400);
    const { groups, total } = await store().matches(pending === '1', ADMIN_PAGE_SIZE, (page - 1) * ADMIN_PAGE_SIZE);
    return json({ groups, total, page, pageSize: ADMIN_PAGE_SIZE });
  }

  const report = /^\/api\/admin\/reports\/([^/]+)$/.exec(p);
  if (report) {
    if (!ID.test(report[1]!)) return notFound();
    if (req.method !== 'PATCH') return notAllowed('PATCH');
    const body = await readPatch(req, env, url, reportPatchSchema);
    if ('response' in body) return body.response;
    let note: string | null | undefined = undefined;
    if (body.value.adminNote !== undefined) {
      note = body.value.adminNote === null ? null : cleanText(body.value.adminNote);
      if (note !== null && note.length > MESSAGE_MAX) return json({ error: 'invalid', field: 'adminNote' }, 400);
    }
    const updated = await store().updateReport(Number(report[1]), body.value.status, note);
    return updated ? json({ report: updated }) : notFound();
  }

  const shop = /^\/api\/admin\/shops\/([^/]+)$/.exec(p);
  if (shop) {
    if (!SLUG.test(shop[1]!)) return notFound();
    if (req.method !== 'PATCH') return notAllowed('PATCH');
    const body = await readPatch(req, env, url, shopPatchSchema);
    if ('response' in body) return body.response;
    const updated = await store().setShopHidden(shop[1]!, body.value.hidden);
    return updated ? json({ shop: updated }) : notFound();
  }

  const match = /^\/api\/admin\/matches\/([^/]+)$/.exec(p);
  if (match) {
    if (!ID.test(match[1]!)) return notFound();
    if (req.method !== 'PATCH') return notAllowed('PATCH');
    const body = await readPatch(req, env, url, matchPatchSchema);
    if ('response' in body) return body.response;
    const updated = await store().confirmMatch(Number(match[1]), body.value.confirmed);
    return updated ? json({ member: updated }) : notFound();
  }

  return notFound();
}
