// The pass rule for a requested shop's test scrape through the normal pipeline: at least 10 distinct products
// (parent products: variants of one product count once) with a title and a price above zero, and no more than
// 20% of the requests failing.
import type { RunTotals } from '../pipeline/store.js';
import type { NormalisedRecord } from '../types.js';

/** Records the test scrape may read: about 50 products even when each has a few variants. */
export const TEST_SCRAPE_LIMIT = 200;
/** Request caps: detection, the test scrape, and the two together for one check. */
export const DETECTION_MAX_REQUESTS = 10;
export const TEST_SCRAPE_MAX_REQUESTS = 55;
export const CHECK_MAX_REQUESTS = 65;
/** Magento pages: the test scrape walks only this many categories (the stored config is not bounded). */
export const TEST_MAGENTO_CATEGORIES = 5;
export const PASS_MIN_PRODUCTS = 10;
export const PASS_MAX_FAILED_RATIO = 0.2;
export const SAMPLE_SIZE = 10;
const TITLE_MAX = 200;
const URL_MAX = 500;

/** One sample product as stored on the request (shown as text on the Add shop page). Price in integer cents. */
export interface SampleProduct {
  title: string | null;
  priceCents: number | null;
  url: string | null;
}

export interface TestScrapeVerdict {
  pass: boolean;
  /** distinct products the run read */
  productsFound: number;
  /** of those, how many have a variant with a title and a price above zero */
  good: number;
  failedRatio: number;
  /** why it failed; null on a pass */
  reason: string | null;
  /** one row per product, good ones first */
  sample: SampleProduct[];
}

const isGood = (r: NormalisedRecord) => !!r.title?.trim() && typeof r.price_cents === 'number' && r.price_cents > 0;
const groupKey = (r: NormalisedRecord) => r.parent_external_id ?? r.external_id;

function toSample(r: NormalisedRecord): SampleProduct {
  const title = r.title?.trim() ? r.title.trim().slice(0, TITLE_MAX) : null;
  return { title, priceCents: typeof r.price_cents === 'number' ? Math.round(r.price_cents) : null, url: r.url ? r.url.slice(0, URL_MAX) : null };
}

export function judgeTestScrape(totals: Pick<RunTotals, 'status' | 'products_seen' | 'requests' | 'failed_requests' | 'notes'>, records: NormalisedRecord[]): TestScrapeVerdict {
  // one representative per product: its first good variant, else its first variant
  const products = new Map<string, NormalisedRecord>();
  for (const r of records) {
    const k = groupKey(r);
    const have = products.get(k);
    if (!have || (!isGood(have) && isGood(r))) products.set(k, r);
  }
  const reps = [...products.values()];
  const good = reps.filter(isGood);
  const failedRatio = totals.requests ? totals.failed_requests / totals.requests : 0;
  const shown = [...good, ...reps.filter((r) => !isGood(r))].slice(0, SAMPLE_SIZE).map(toSample);
  let reason: string | null = null;
  if (totals.products_seen === 0 || totals.status === 'failed' || reps.length === 0) {
    reason = `No products were read.${totals.notes ? ` ${totals.notes}` : ''}`;
  } else if (good.length < PASS_MIN_PRODUCTS) {
    reason = `Only ${good.length} products with a title and a price above zero (at least ${PASS_MIN_PRODUCTS} needed).`;
  } else if (failedRatio > PASS_MAX_FAILED_RATIO) {
    reason = `${totals.failed_requests} of ${totals.requests} requests failed (${Math.round(failedRatio * 100)}%; at most ${PASS_MAX_FAILED_RATIO * 100}% allowed).`;
  }
  return { pass: reason === null, productsFound: reps.length, good: good.length, failedRatio, reason, sample: shown };
}
