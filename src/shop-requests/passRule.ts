// The pass rule for a requested shop's test scrape (50 products through the normal pipeline): at least 10
// products with a title and a price above zero, and no more than 20% of the requests failing.
import type { RunTotals } from '../pipeline/store.js';
import type { NormalisedRecord } from '../types.js';

export const TEST_SCRAPE_LIMIT = 50;
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
  /** products the run read */
  productsFound: number;
  /** of those in the sample, how many have a title and a price above zero */
  good: number;
  failedRatio: number;
  /** why it failed; null on a pass */
  reason: string | null;
  sample: SampleProduct[];
}

const isGood = (r: NormalisedRecord) => !!r.title?.trim() && typeof r.price_cents === 'number' && r.price_cents > 0;

function toSample(r: NormalisedRecord): SampleProduct {
  const title = r.title?.trim() ? r.title.trim().slice(0, TITLE_MAX) : null;
  return { title, priceCents: typeof r.price_cents === 'number' ? Math.round(r.price_cents) : null, url: r.url ? r.url.slice(0, URL_MAX) : null };
}

export function judgeTestScrape(totals: Pick<RunTotals, 'status' | 'products_seen' | 'requests' | 'failed_requests' | 'notes'>, sample: NormalisedRecord[]): TestScrapeVerdict {
  const good = sample.filter(isGood);
  const failedRatio = totals.requests ? totals.failed_requests / totals.requests : 0;
  const shown = [...good, ...sample.filter((r) => !isGood(r))].slice(0, SAMPLE_SIZE).map(toSample);
  let reason: string | null = null;
  if (totals.products_seen === 0 || totals.status === 'failed') {
    reason = `No products were read.${totals.notes ? ` ${totals.notes}` : ''}`;
  } else if (good.length < PASS_MIN_PRODUCTS) {
    reason = `Only ${good.length} products with a title and a price above zero (at least ${PASS_MIN_PRODUCTS} needed).`;
  } else if (failedRatio > PASS_MAX_FAILED_RATIO) {
    reason = `${totals.failed_requests} of ${totals.requests} requests failed (${Math.round(failedRatio * 100)}%; at most ${PASS_MAX_FAILED_RATIO * 100}% allowed).`;
  }
  return { pass: reason === null, productsFound: totals.products_seen, good: good.length, failedRatio, reason, sample: shown };
}
