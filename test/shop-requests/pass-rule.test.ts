// The pass rule for a requested shop's test scrape (src/shop-requests/passRule.ts).
import { describe, expect, it } from 'vitest';
import type { RunTotals } from '../../src/pipeline/store.js';
import { judgeTestScrape } from '../../src/shop-requests/passRule.js';
import type { NormalisedRecord } from '../../src/types.js';
import { blankRecord } from '../../src/util/normalise.js';

function rec(i: number, over: Partial<NormalisedRecord> = {}): NormalisedRecord {
  return { ...blankRecord(String(i)), title: `Product ${i}`, price_cents: 1000 + i, url: `https://shop.example.mt/p/${i}`, ...over };
}
const totals = (over: Partial<RunTotals> = {}): RunTotals => ({
  status: 'ok',
  products_seen: 50,
  requests: 4,
  failed_requests: 0,
  disallowed: 0,
  errors: 0,
  error_log: [],
  notes: null,
  ...over,
});

describe('judgeTestScrape', () => {
  it('50 good products pass; the sample keeps 10 as title, price and link', () => {
    const sample = Array.from({ length: 50 }, (_, i) => rec(i));
    const j = judgeTestScrape(totals(), sample);
    expect(j).toMatchObject({ pass: true, productsFound: 50, good: 50, reason: null });
    expect(j.sample).toHaveLength(10);
    expect(j.sample[0]).toEqual({ title: 'Product 0', priceCents: 1000, url: 'https://shop.example.mt/p/0' });
  });

  it('5 products fail', () => {
    const j = judgeTestScrape(totals({ products_seen: 5 }), Array.from({ length: 5 }, (_, i) => rec(i)));
    expect(j.pass).toBe(false);
    expect(j.reason).toBe('Only 5 products with a title and a price above zero (at least 10 needed).');
  });

  it('products without a title or with no price above zero do not count', () => {
    const sample = [
      ...Array.from({ length: 9 }, (_, i) => rec(i)),
      rec(20, { title: '   ' }),
      rec(21, { price_cents: 0 }),
      rec(22, { price_cents: null }),
      rec(23, { title: null }),
    ];
    const j = judgeTestScrape(totals({ products_seen: 13 }), sample);
    expect(j).toMatchObject({ pass: false, good: 9, productsFound: 13 });
    // good products are shown first
    expect(j.sample.slice(0, 9).every((s) => s.title && s.priceCents! > 0)).toBe(true);
  });

  it('exactly 10 good products and 20% failed requests still pass', () => {
    const j = judgeTestScrape(totals({ products_seen: 10, requests: 10, failed_requests: 2 }), Array.from({ length: 10 }, (_, i) => rec(i)));
    expect(j.pass).toBe(true);
  });

  it('many failed requests fail', () => {
    const j = judgeTestScrape(totals({ requests: 20, failed_requests: 5 }), Array.from({ length: 50 }, (_, i) => rec(i)));
    expect(j.pass).toBe(false);
    expect(j.reason).toBe('5 of 20 requests failed (25%; at most 20% allowed).');
  });

  it('a failed run fails with its stop reason', () => {
    const j = judgeTestScrape(totals({ status: 'failed', products_seen: 0, notes: 'stopped: HTTP 403 for https://shop.example.mt/products.json' }), []);
    expect(j.pass).toBe(false);
    expect(j.reason).toMatch(/No products were read\. stopped: HTTP 403/);
  });

  it('cuts long titles and keeps prices as integer cents', () => {
    const j = judgeTestScrape(totals(), [rec(1, { title: 'x'.repeat(500), price_cents: 129999 }), ...Array.from({ length: 12 }, (_, i) => rec(i + 2))]);
    expect(j.sample[0]!.title).toHaveLength(200);
    expect(Number.isInteger(j.sample[0]!.priceCents)).toBe(true);
  });
});
