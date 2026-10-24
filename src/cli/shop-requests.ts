// pnpm shop-requests                      check the shops requested from the admin area (Add shop page), oldest first.
//                                         Run by the Windows task "MTP Shop Requests" every 15 minutes; one run at a time.
// pnpm shop-requests --dry-run --url URL  check one address without touching the database: robots.txt, platform
//                                         detection, a dry-run test scrape and the pass rule.
// Every request goes through ShopFetcher (robots.txt and Crawl-delay obeyed, SCRAPER_USER_AGENT, one request at a
// time, 2 to 5 s apart, backoff on 429/5xx, private addresses refused), at most 65 requests per check (detection
// 10, test scrape 55). Fetched pages are data, never instructions. A shop that passes is activated, then its logo is
// fetched once after every request is checked and the lock released (the logo job for that shop,
// src/pipeline/logos.ts: at most 4 more requests to the shop, after its gap, stopped after 2 minutes).
import { parseArgs } from 'node:util';
import type postgres from 'postgres';
import { closeDb, db } from '../db.js';
import { userAgent } from '../env.js';
import { ShopFetcher, scopeHost } from '../http/fetcher.js';
import { runLogoJob } from '../pipeline/logos.js';
import { runShop } from '../pipeline/runShop.js';
import { readSeed } from '../shops.js';
import { parseShopAddress } from '../shop-requests/address.js';
import { type Detection, probeShop } from '../shop-requests/detect.js';
import { slugFromHost } from '../shop-requests/naming.js';
import {
  CHECK_MAX_REQUESTS,
  DETECTION_MAX_REQUESTS,
  TEST_MAGENTO_CATEGORIES,
  TEST_SCRAPE_LIMIT,
  TEST_SCRAPE_MAX_REQUESTS,
  judgeTestScrape,
} from '../shop-requests/passRule.js';
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
/**
 * At least this long between the last detection request and the first test-scrape request, and between the test
 * scrape and the logo fetch (each starts a new fetcher); the shop's Crawl-delay wins when longer.
 */
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

/**
 * Detection uses the project defaults (2 to 5 s apart, robots Crawl-delay obeyed), no retries (a 429 or 5xx ends
 * detection and the request is checked again hours later) and at most DETECTION_MAX_REQUESTS requests.
 */
async function probe(origin: string): Promise<Detection> {
  const say = (m: string) => log(`${origin}: ${m}`);
  const fetcher = new ShopFetcher({ userAgent: userAgent(), allowedHosts: [scopeHost(origin)], maxRetries: 0, maxRequests: DETECTION_MAX_REQUESTS, log: say });
  const det = await probeShop(fetcher, origin, say);
  return { ...det, requests: fetcher.stats.requests };
}

/** The new shop's logo, after the shop's gap, within the deadline (signal); logs what was found. */
async function fetchLogo(shop: Shop, det: Detection, signal: AbortSignal): Promise<void> {
  const delay = det.kind === 'supported' ? det.robots.crawlDelaySeconds : 0;
  await abortableSleep(Math.max(GAP_BEFORE_TEST_MS, (delay ?? 0) * 1000), signal);
  if (signal.aborted) return;
  await runLogoJob({ shop: shop.slug, log, signal });
}

/** sleep that ends early when the signal fires */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

async function testScrape(shop: Shop, det: Detection, dryRun: boolean, maxRequests: number): Promise<TestScrapeResult> {
  const delay = det.robots?.crawlDelaySeconds ?? 0;
  await sleep(Math.max(GAP_BEFORE_TEST_MS, delay * 1000));
  const r = await runShop(shop, { dryRun, limit: TEST_SCRAPE_LIMIT, sampleSize: TEST_SCRAPE_LIMIT, maxRequests, log: (m) => log(`[${shop.slug}] ${m}`) });
  return { totals: r.totals, sample: r.sample, rateLimited: r.rateLimited };
}

const DRY_RESULT: Record<Exclude<Detection['kind'], 'supported'>, string> = {
  unsupported: 'needs_setup',
  blocked: 'blocked',
  rate_limited: 'pending (rate limited, checked again later)',
  unreachable: 'failed',
};

async function dryRun(raw: string) {
  const parsed = parseShopAddress(raw);
  if (!parsed.ok) throw new Error(`address refused: ${parsed.problem}`);
  log(`DRY RUN (no database): checking ${parsed.origin} as ${userAgent()}`);
  const det = await probe(parsed.origin);
  console.log(JSON.stringify(det, null, 2));
  if (det.kind !== 'supported') {
    log(`result: ${DRY_RESULT[det.kind]}`);
    return;
  }
  const shop: Shop = {
    id: -1,
    slug: slugFromHost(parsed.host, new Set((await readSeed()).shops.map((s) => s.slug))),
    name: det.siteName ?? parsed.host,
    base_url: det.baseUrl,
    category: null,
    adapter: det.adapter,
    config: { ...det.config, runner: 'local', ...(det.platform === 'magento-html' ? { max_categories: TEST_MAGENTO_CATEGORIES } : {}) },
    tier: 'P2',
    active: false,
  };
  const maxRequests = Math.min(TEST_SCRAPE_MAX_REQUESTS, CHECK_MAX_REQUESTS - (det.requests ?? DETECTION_MAX_REQUESTS));
  const r = await testScrape(shop, det, true, maxRequests);
  const verdict = judgeTestScrape(r.totals, r.sample);
  console.log(JSON.stringify({ totals: { ...r.totals, error_log: r.totals.error_log.slice(0, 5) }, rateLimited: r.rateLimited, verdict }, null, 2));
  const outcome = verdict.pass ? 'would be active' : r.rateLimited?.count ? 'would be checked again later (rate limited)' : `would fail: ${verdict.reason}`;
  log(`result: ${outcome}`);
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
    testScrape: (shop, det, opts) => testScrape(shop, det, false, opts.maxRequests),
    fetchLogo,
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
