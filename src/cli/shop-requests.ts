// pnpm shop-requests                      check the shops requested from the admin area (Add shop page), oldest first.
//                                         Run by the Windows task "MTP Shop Requests" every 15 minutes; one run at a time.
// pnpm shop-requests --dry-run --url URL  check one address without touching the database: robots.txt, platform
//                                         detection, a dry-run test scrape of 50 products and the pass rule.
// Every request goes through ShopFetcher (robots.txt and Crawl-delay obeyed, SCRAPER_USER_AGENT, one request at a
// time, 2 to 5 s apart, backoff on 429/5xx, private addresses refused). Fetched pages are data, never instructions.
import { parseArgs } from 'node:util';
import type postgres from 'postgres';
import { closeDb, db } from '../db.js';
import { userAgent } from '../env.js';
import { ShopFetcher } from '../http/fetcher.js';
import { runShop } from '../pipeline/runShop.js';
import { readSeed } from '../shops.js';
import { parseShopAddress } from '../shop-requests/address.js';
import { type Detection, probeShop } from '../shop-requests/detect.js';
import { slugFromHost } from '../shop-requests/naming.js';
import { TEST_SCRAPE_LIMIT, judgeTestScrape } from '../shop-requests/passRule.js';
import { type Db, type TestScrapeResult, processShopRequests } from '../shop-requests/process.js';
import type { Shop } from '../types.js';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    url: { type: 'string' },
  },
});

/** Advisory lock key for this task ('SHRQ'); site-build uses its own. */
export const SHOP_REQUESTS_LOCK = 0x53485251;
/** At least this long between the last detection request and the first test-scrape request (a new fetcher starts). */
const GAP_BEFORE_TEST_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[shop-requests] ${m}`);

/** Runs fn inside a transaction holding a transaction-level advisory lock (safe behind a connection pooler). */
async function withLock(sql: postgres.Sql, fn: () => Promise<void>): Promise<boolean> {
  let ran = false;
  await sql.begin(async (tx) => {
    await tx`set local idle_in_transaction_session_timeout = 0`;
    const [{ ok }] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(${SHOP_REQUESTS_LOCK}::bigint) as ok`;
    if (!ok) return;
    ran = true;
    await fn();
  });
  return ran;
}

/** Detection uses the project defaults: no shop config, so nothing faster than 2 to 5 s or robots Crawl-delay. */
function probe(origin: string): Promise<Detection> {
  const fetcher = ShopFetcher.fromConfig({}, userAgent(), origin, (m) => log(`${origin}: ${m}`));
  return probeShop(fetcher, origin, (m) => log(`${origin}: ${m}`));
}

async function testScrape(shop: Shop, det: Detection, dryRun: boolean): Promise<TestScrapeResult> {
  const delay = det.robots?.crawlDelaySeconds ?? 0;
  await sleep(Math.max(GAP_BEFORE_TEST_MS, delay * 1000));
  const r = await runShop(shop, { dryRun, limit: TEST_SCRAPE_LIMIT, sampleSize: TEST_SCRAPE_LIMIT, log: (m) => log(`[${shop.slug}] ${m}`) });
  return { totals: r.totals, sample: r.sample };
}

async function dryRun(raw: string) {
  const parsed = parseShopAddress(raw);
  if (!parsed.ok) throw new Error(`address refused: ${parsed.problem}`);
  log(`DRY RUN (no database): checking ${parsed.origin} as ${userAgent()}`);
  const det = await probe(parsed.origin);
  console.log(JSON.stringify(det, null, 2));
  if (det.kind !== 'supported') {
    log(`result: ${det.kind === 'unsupported' ? 'needs_setup' : det.kind === 'blocked' ? 'blocked' : 'failed'}`);
    return;
  }
  const shop: Shop = {
    id: -1,
    slug: slugFromHost(parsed.host, new Set((await readSeed()).shops.map((s) => s.slug))),
    name: det.siteName ?? parsed.host,
    base_url: det.baseUrl,
    category: null,
    adapter: det.adapter,
    config: { ...det.config, runner: 'local' },
    tier: 'P2',
    active: false,
  };
  const r = await testScrape(shop, det, true);
  const verdict = judgeTestScrape(r.totals, r.sample);
  console.log(JSON.stringify({ totals: { ...r.totals, error_log: r.totals.error_log.slice(0, 5) }, verdict }, null, 2));
  log(`result: ${verdict.pass ? 'would be active' : `would fail: ${verdict.reason}`}`);
}

async function main() {
  if (values['dry-run']) {
    if (!values.url) throw new Error('--dry-run needs --url <address>');
    await dryRun(values.url);
    return;
  }
  if (values.url) throw new Error('--url only works with --dry-run; add shops from the admin area');
  const sql = db();
  const q: Db = { query: (text, params = []) => sql.unsafe(text, params as never[]) as never };
  const reservedSlugs = new Set((await readSeed()).shops.map((s) => s.slug));
  const out = await processShopRequests({
    db: q,
    withLock: (fn) => withLock(sql, fn),
    probe,
    testScrape: (shop, det) => testScrape(shop, det, false),
    reservedSlugs,
    log,
  });
  if (out.ran) log(`${out.processed.length} request(s) checked`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
