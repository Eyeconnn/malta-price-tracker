// The PC task behind pnpm shop-requests: checks the shops requested from the admin area, oldest first.
// For each: re-validate the stored address, refuse a host that is already a shop, read robots.txt and detect
// the platform (detect.ts), then either mark it needs_setup / blocked / failed, or create the shop inactive
// (runner local, tier P2), run a capped test scrape through the normal pipeline and activate it when the pass
// rule holds. A shop that rate-limits us (429 or a retryable 5xx, at any step) goes back to pending and is not
// checked again before the longer of its Retry-After and 2 h, then 8 h, then 24 h; a fourth time it fails.
// Network and the test scrape are injected (deps) so the database side is tested on PGlite.
// A crash inside one check leaves that request failed with the error; a request left in checking by a
// killed run is reset to failed after an hour. The whole run happens under a lock, so overlapping runs do nothing.
import type { RunTotals } from '../pipeline/store.js';
import type { NormalisedRecord, Shop } from '../types.js';
import { NAME_MAX, SHOP_CATEGORIES, cleanDisplayName, hostKey, parseShopAddress } from './address.js';
import type { Detection } from './detect.js';
import { slugFromHost } from './naming.js';
import { CHECK_MAX_REQUESTS, DETECTION_MAX_REQUESTS, TEST_MAGENTO_CATEGORIES, TEST_SCRAPE_MAX_REQUESTS, judgeTestScrape } from './passRule.js';
import type { ShopRequestStatus } from './statuses.js';

type Row = Record<string, unknown>;

/** $n-parameter SQL as the database owner (postgres.js in production, PGlite in tests). */
export interface Db {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface TestScrapeResult {
  totals: RunTotals;
  sample: NormalisedRecord[];
  /** requests that finally failed with 429 or a retryable 5xx, and the last Retry-After seen */
  rateLimited?: { count: number; retryAfterMs: number | null };
}

export interface ProcessDeps {
  db: Db;
  /** runs fn only when no other run holds the lock; false when it was held */
  withLock(fn: () => Promise<void>): Promise<boolean>;
  /** robots.txt and platform detection for an origin; requests: how many detection used */
  probe(origin: string): Promise<Detection>;
  /** the test scrape of the new (inactive) shop, never more than maxRequests requests */
  testScrape(shop: Shop, detection: Detection, opts: { maxRequests: number }): Promise<TestScrapeResult>;
  /** slugs that belong to shops.seed.json, never given to a new shop */
  reservedSlugs: Set<string>;
  log?: (msg: string) => void;
}

/** A check that started longer ago than this was interrupted (the PC slept or the run was killed). */
export const STUCK_AFTER_MINUTES = 60;
/** Waits after the 1st, 2nd and 3rd rate limiting (at least; a longer Retry-After wins). */
export const RATE_LIMIT_WAITS_MS = [2 * 3_600_000, 8 * 3_600_000, 24 * 3_600_000];
/** Never more than this many checks in one run (the queue is capped at 20 anyway). */
const MAX_PER_RUN = 25;
const ERROR_MAX = 500;

interface Outcome {
  status: Exclude<ShopRequestStatus, 'checking' | 'rejected'>;
  error: string | null;
  platform?: string | null;
  robots?: unknown;
  productsFound?: number | null;
  sample?: unknown;
  details?: unknown;
  shopId?: number | null;
  /** pending again: check no sooner than this many ms from now */
  retryInMs?: number;
  rateLimitedCount?: number;
}

const jsonOrNull = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
const clipError = (s: string | null) => (s === null ? null : s.length > ERROR_MAX ? `${s.slice(0, ERROR_MAX - 3)}...` : s);

async function resetStuck(db: Db): Promise<number> {
  const rows = await db.query(
    `update shop_requests set status = 'failed', checked_at = now(), next_check_at = null,
       error = 'The check was interrupted (it stayed in checking for over an hour). Retry it.'
     where status = 'checking' and coalesce(started_at, requested_at) < now() - ($1::int * interval '1 minute')
     returning id`,
    [STUCK_AFTER_MINUTES],
  );
  return rows.length;
}

/** The request's own shop (on a retry) or a new one; always inactive until the test scrape passes. */
async function saveShop(db: Db, req: Row, det: Extract<Detection, { kind: 'supported' }>, reserved: Set<string>): Promise<Shop> {
  const name = (cleanDisplayName(req.display_name as string | null)?.slice(0, NAME_MAX).trimEnd() || det.siteName || hostKey(det.baseUrl)).slice(0, NAME_MAX);
  const category = (SHOP_CATEGORIES as readonly string[]).includes(String(req.shop_category)) ? String(req.shop_category) : null;
  const config = { ...det.config, runner: 'local' };
  const notes = `Added from the admin area (shop request ${String(req.id)}, platform ${det.platform}, ${new Date().toISOString().slice(0, 10)}).`;
  const cols = 'id, slug, name, base_url, category, adapter, config, tier, active';

  if (req.shop_id !== null && req.shop_id !== undefined) {
    const [row] = await db.query<Row>(
      `update shops set name = $2, base_url = $3, category = $4, adapter = $5, config = $6::text::jsonb, tier = 'P2', active = false,
         notes = $7, updated_at = now()
       where id = $1 returning ${cols}`,
      [req.shop_id, name, det.baseUrl, category, det.adapter, JSON.stringify(config), notes],
    );
    if (row) return toShop(row);
  }
  const taken = new Set([...reserved, ...(await db.query<{ slug: string }>('select slug from shops')).map((r) => r.slug)]);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = slugFromHost(hostKey(det.baseUrl), taken);
    const [row] = await db.query<Row>(
      `insert into shops (slug, name, base_url, category, adapter, config, tier, active, notes)
       values ($1, $2, $3, $4, $5, $6::text::jsonb, 'P2', false, $7)
       on conflict (slug) do nothing returning ${cols}`,
      [slug, name, det.baseUrl, category, det.adapter, JSON.stringify(config), notes],
    );
    if (row) return toShop(row);
    taken.add(slug);
  }
  throw new Error('could not find a free slug for the shop');
}

function toShop(r: Row): Shop {
  return {
    id: Number(r.id),
    slug: String(r.slug),
    name: String(r.name),
    base_url: String(r.base_url),
    category: r.category === null || r.category === undefined ? null : String(r.category),
    adapter: r.adapter as Shop['adapter'],
    config: (typeof r.config === 'string' ? JSON.parse(r.config) : r.config) as Shop['config'],
    tier: r.tier as Shop['tier'],
    active: Boolean(r.active),
  };
}

async function existingShop(db: Db, address: string, ownShopId: unknown): Promise<string | null> {
  const key = hostKey(address);
  const shops = await db.query<{ id: number; slug: string; base_url: string }>('select id, slug, base_url from shops');
  const hit = shops.find((s) => hostKey(s.base_url) === key && (ownShopId === null || ownShopId === undefined || Number(s.id) !== Number(ownShopId)));
  return hit ? hit.slug : null;
}

/** Back to pending for later, or failed once the automatic retries are used up. */
function rateLimited(req: Row, reason: string, retryAfterMs: number | null, extra: Partial<Outcome> = {}): Outcome {
  const n = Number(req.rate_limited_count ?? 0) + 1;
  if (n > RATE_LIMIT_WAITS_MS.length) {
    return { ...extra, status: 'failed', error: `Rate-limited repeatedly (${n} checks in a row): ${reason} Retry it by hand later.`, rateLimitedCount: n };
  }
  const wait = Math.max(retryAfterMs ?? 0, RATE_LIMIT_WAITS_MS[n - 1]!);
  return { ...extra, status: 'pending', error: `${reason} Checking again automatically (${n} of ${RATE_LIMIT_WAITS_MS.length}).`, retryInMs: wait, rateLimitedCount: n };
}

async function check(d: ProcessDeps, req: Row, log: (m: string) => void): Promise<Outcome> {
  const origin = String(req.origin);
  // the Worker checked it, but nothing is fetched on the strength of a stored value alone
  const valid = parseShopAddress(origin);
  if (!valid.ok || valid.origin !== origin) return { status: 'failed', error: `The stored address is not a valid shop address (${valid.ok ? 'not an origin' : valid.problem}).` };
  const dup = await existingShop(d.db, origin, req.shop_id);
  if (dup) return { status: 'failed', error: `This address is already a shop (${dup}).` };

  const det = await d.probe(origin);
  log(`${origin}: ${det.kind}${'platform' in det && det.platform ? ` (${det.platform})` : ''}`);
  if (det.kind === 'rate_limited') return rateLimited(req, det.reason, det.retryAfterMs, { robots: det.robots });
  if (det.kind === 'unreachable') return { status: 'failed', error: det.reason, robots: det.robots };
  if (det.kind === 'blocked') return { status: 'blocked', error: det.reason, platform: det.platform, robots: det.robots };
  if (det.kind === 'unsupported') return { status: 'needs_setup', error: det.reason, platform: det.platform, robots: det.robots, details: det.details };

  // the home page may have moved the base address (apex to www.)
  const dupBase = det.baseUrl === origin ? null : await existingShop(d.db, det.baseUrl, req.shop_id);
  if (dupBase) return { status: 'failed', error: `This address is already a shop (${dupBase}).`, platform: det.platform, robots: det.robots };

  const shop = await saveShop(d.db, req, det, d.reservedSlugs);
  // recorded before the test scrape, so a retry after a crash reuses this shop
  await d.db.query('update shop_requests set shop_id = $2, platform = $3, robots = $4::text::jsonb where id = $1', [req.id, shop.id, det.platform, JSON.stringify(det.robots)]);
  // one check stays within CHECK_MAX_REQUESTS: detection plus the test scrape
  const maxRequests = Math.max(0, Math.min(TEST_SCRAPE_MAX_REQUESTS, CHECK_MAX_REQUESTS - (det.requests ?? DETECTION_MAX_REQUESTS)));
  // Magento pages: walk a few categories for the test only; the stored config stays unbounded for the nightly run
  const testShop = det.platform === 'magento-html' ? { ...shop, config: { ...shop.config, max_categories: TEST_MAGENTO_CATEGORIES } } : shop;
  log(`${origin}: shop ${shop.slug} saved inactive, test scrape of at most ${maxRequests} requests`);
  const result = await d.testScrape(testShop, det, { maxRequests });
  const verdict = judgeTestScrape(result.totals, result.sample);
  const found = { platform: det.platform, robots: det.robots, productsFound: verdict.productsFound, sample: verdict.sample, shopId: shop.id };
  if (!verdict.pass && result.rateLimited && result.rateLimited.count > 0) {
    return rateLimited(req, `The test scrape was slowed down by the shop (${result.rateLimited.count} requests answered 429 or a server error).`, result.rateLimited.retryAfterMs, found);
  }
  return { ...found, status: verdict.pass ? 'active' : 'failed', error: verdict.reason };
}

/** Stores the outcome, and activates the shop in the same statement; a request rejected meanwhile is left as it is. */
async function finish(db: Db, id: unknown, o: Outcome): Promise<boolean> {
  const [row] = await db.query<{ updated: number }>(
    `with r as (
       update shop_requests set status = $2, checked_at = now(), error = $3,
         platform = coalesce($4, platform), robots = coalesce($5::text::jsonb, robots), products_found = $6,
         sample = $7::text::jsonb, details = $8::text::jsonb, shop_id = coalesce($9::int, shop_id),
         next_check_at = case when $11::bigint is null then null else now() + $11::bigint * interval '1 millisecond' end,
         rate_limited_count = coalesce($12::int, rate_limited_count)
       where id = $1 and status = 'checking'
       returning shop_id),
     s as (
       update shops set active = true, updated_at = now()
       where $10::boolean and id in (select shop_id from r)
       returning id)
     select (select count(*) from r)::int as updated, (select count(*) from s)::int as activated`,
    [
      id,
      o.status,
      clipError(o.error),
      o.platform ?? null,
      jsonOrNull(o.robots),
      o.productsFound ?? null,
      jsonOrNull(o.sample),
      jsonOrNull(o.details),
      o.shopId ?? null,
      o.status === 'active',
      o.retryInMs === undefined ? null : Math.round(o.retryInMs),
      o.rateLimitedCount ?? null,
    ],
  );
  return Number(row?.updated ?? 0) > 0;
}

export async function processShopRequests(d: ProcessDeps): Promise<{ ran: boolean; processed: { id: number; origin: string; status: string }[] }> {
  const log = d.log ?? ((m: string) => console.log(m));
  const processed: { id: number; origin: string; status: string }[] = [];
  const ran = await d.withLock(async () => {
    const reset = await resetStuck(d.db);
    if (reset) log(`${reset} request(s) stuck in checking for over an hour set to failed`);
    for (let n = 0; n < MAX_PER_RUN; n++) {
      // a request waiting after rate limiting is due once its next_check_at has passed
      const [next] = await d.db.query<{ id: number }>(
        `select id from shop_requests where status = 'pending' and (next_check_at is null or next_check_at <= now())
         order by requested_at, id limit 1`,
      );
      if (!next) break;
      const [req] = await d.db.query<Row>(
        `update shop_requests set status = 'checking', attempts = attempts + 1, started_at = now(), error = null
         where id = $1 and status = 'pending' returning *`,
        [next.id],
      );
      if (!req) continue;
      let outcome: Outcome;
      try {
        outcome = await check(d, req, log);
      } catch (e) {
        outcome = { status: 'failed', error: `The check stopped with an error: ${(e as Error).message}` };
      }
      const stored = await finish(d.db, req.id, outcome);
      const status = stored ? outcome.status : 'rejected meanwhile, left as it is';
      log(`${String(req.origin)}: ${status}${outcome.error ? `: ${outcome.error}` : ''}`);
      processed.push({ id: Number(req.id), origin: String(req.origin), status });
    }
  });
  if (!ran) log('another shop-requests run holds the lock, nothing to do');
  return { ran, processed };
}
