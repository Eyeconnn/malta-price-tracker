// The PC task (src/shop-requests/process.ts) on PGlite: the rate-limit retry policy (2 h or Retry-After, 8 h,
// 24 h, then failed), request caps passed to the test scrape, the bounded Magento test config, re-validation
// of stored origins, and the origin and host rules of migration 009.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunTotals } from '../../src/pipeline/store.js';
import { PROBE_PATHS, probeShop } from '../../src/shop-requests/detect.js';
import { type Db, type ProcessDeps, type TestScrapeResult, processShopRequests } from '../../src/shop-requests/process.js';
import type { NormalisedRecord, Shop } from '../../src/types.js';
import { blankRecord } from '../../src/util/normalise.js';
import { type Recorded, fakeFetcher, fixture } from './fake-fetcher.js';

let pg: PGlite;
const db: Db = { query: async (text, params = []) => (await pg.query<Record<string, unknown>>(text, params)).rows as never };

const HOUR = 3_600_000;
const sites: Record<string, { routes: Record<string, Recorded>; robots?: string; requests?: number }> = {};
const probed: string[] = [];
const scrapes: { shop: Shop; maxRequests: number }[] = [];
let scrapeResult: (shop: Shop) => TestScrapeResult = () => ({ totals: totals({ products_seen: 50 }), sample: good(50) });

const rec = (i: number): NormalisedRecord => ({ ...blankRecord(String(i)), title: `Item ${i}`, price_cents: 500 + i, url: null });
const good = (n: number) => Array.from({ length: n }, (_, i) => rec(i));
const totals = (over: Partial<RunTotals>): RunTotals => ({ status: 'ok', products_seen: 0, requests: 5, failed_requests: 0, disallowed: 0, errors: 0, error_log: [], notes: null, ...over });

const deps: ProcessDeps = {
  db,
  withLock: async (fn) => {
    await fn();
    return true;
  },
  probe: async (origin) => {
    probed.push(origin);
    const site = sites[origin]!;
    const f = fakeFetcher(origin, site.routes, site.robots ? { [origin]: site.robots } : {});
    const d = await probeShop(f, origin);
    return { ...d, requests: site.requests ?? f.requests.length };
  },
  testScrape: async (shop, _det, opts) => {
    scrapes.push({ shop, maxRequests: opts.maxRequests });
    return scrapeResult(shop);
  },
  reservedSlugs: new Set(),
  log: () => {},
};

const row = async (origin: string) => (await pg.query<Record<string, unknown>>('select *, extract(epoch from (next_check_at - now())) * 1000 as wait_ms from shop_requests where origin = $1 order by id desc limit 1', [origin])).rows[0]!;
const add = (origin: string) => pg.query(`insert into shop_requests (origin) values ($1)`, [origin]);
const due = (origin: string) => pg.query(`update shop_requests set next_check_at = now() - interval '1 minute' where origin = $1`, [origin]);
const near = (ms: unknown, expected: number) => expect(Math.abs(Number(ms) - expected)).toBeLessThan(5 * 60_000);

beforeAll(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  pg = await PGlite.create({ dataDir: 'memory://', extensions: { pg_trgm } });
  const dir = path.resolve('db/migrations');
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(await readFile(path.join(dir, f), 'utf8'));
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('rate limiting', () => {
  const O = 'https://busy.example.mt';

  it('a 429 sends the request back to pending until the longer of Retry-After and 2 h, then 8 h, then 24 h, then failed', async () => {
    sites[O] = { routes: { [`${O}/`]: { status: 429, body: '', headers: { 'retry-after': String(3 * 3600) } } } };
    await add(O);
    await processShopRequests(deps);
    let r = await row(O);
    expect(r).toMatchObject({ status: 'pending', rate_limited_count: 1, attempts: 1 });
    expect(r.error).toMatch(/home page answered HTTP 429.*Checking again automatically \(1 of 3\)/);
    near(r.wait_ms, 3 * HOUR);

    // not due yet: the next run leaves it alone
    const before = probed.length;
    await processShopRequests(deps);
    expect(probed.length).toBe(before);

    sites[O] = { routes: { [`${O}/`]: { status: 429, body: '' } } };
    await due(O);
    await processShopRequests(deps);
    r = await row(O);
    expect(r).toMatchObject({ status: 'pending', rate_limited_count: 2 });
    near(r.wait_ms, 8 * HOUR);

    await due(O);
    await processShopRequests(deps);
    r = await row(O);
    expect(r).toMatchObject({ status: 'pending', rate_limited_count: 3 });
    near(r.wait_ms, 24 * HOUR);

    await due(O);
    await processShopRequests(deps);
    r = await row(O);
    expect(r).toMatchObject({ status: 'failed', attempts: 4, next_check_at: null });
    expect(r.error).toMatch(/rate-limited repeatedly/i);
  });

  it('a manual retry starts the automatic retries afresh', async () => {
    await pg.query(`update shop_requests set status = 'pending' where origin = $1`, [O]);
    expect(await row(O)).toMatchObject({ status: 'pending', rate_limited_count: 0, next_check_at: null });
  });

  it('a test scrape slowed by 429s is retried later; its shop stays inactive, then passes', async () => {
    const T = 'https://slow.example.mt';
    sites[T] = { routes: { [`${T}/`]: { body: fixture('shopify-home.html') }, [`${T}${PROBE_PATHS.shopify}`]: { body: fixture('shopify-products.json') } } };
    scrapeResult = () => ({ totals: totals({ products_seen: 3, requests: 8, failed_requests: 5 }), sample: good(3), rateLimited: { count: 5, retryAfterMs: null } });
    await add(T);
    await processShopRequests(deps);
    let r = await row(T);
    expect(r).toMatchObject({ status: 'pending', rate_limited_count: 1, products_found: 3 });
    expect(r.error).toMatch(/test scrape/);
    near(r.wait_ms, 2 * HOUR);
    const shopId = r.shop_id;
    expect((await pg.query<{ active: boolean }>('select active from shops where id = $1', [shopId])).rows[0]!.active).toBe(false);

    scrapeResult = () => ({ totals: totals({ products_seen: 50 }), sample: good(50) });
    await due(T);
    await processShopRequests(deps);
    r = await row(T);
    expect(r).toMatchObject({ status: 'active', shop_id: shopId, next_check_at: null });
  });
});

describe('request caps and the test config', () => {
  it('the test scrape gets at most 55 requests and at most 65 minus what detection used', async () => {
    const A = 'https://caps-a.example.mt';
    const B = 'https://caps-b.example.mt';
    for (const o of [A, B]) sites[o] = { routes: { [`${o}/`]: { body: fixture('shopify-home.html') }, [`${o}${PROBE_PATHS.shopify}`]: { body: fixture('shopify-products.json') } } };
    sites[B]!.requests = 20;
    scrapes.length = 0;
    await add(A);
    await add(B);
    await processShopRequests(deps);
    expect(scrapes.map((s) => [s.shop.base_url, s.maxRequests])).toEqual([
      [A, 55],
      [B, 45],
    ]);
  });

  it('Magento pages are test-scraped over 5 categories only; the stored config is not bounded', async () => {
    const M = 'https://mage.example.mt';
    sites[M] = { routes: { [`${M}/`]: { body: fixture('magento-home.html') }, [`${M}${PROBE_PATHS.magento}`]: { body: fixture('magento-graphql-error.json') } } };
    scrapes.length = 0;
    await add(M);
    await processShopRequests(deps);
    expect(scrapes[0]!.shop.config).toEqual({ runner: 'local', max_categories: 5 });
    const r = await row(M);
    expect(r).toMatchObject({ status: 'active', platform: 'magento-html' });
    expect((await pg.query<{ config: unknown }>('select config from shops where id = $1', [r.shop_id])).rows[0]!.config).toEqual({ runner: 'local' });
  });

  it('a Crawl-delay above 30 s needs setup', async () => {
    const C = 'https://crawly.example.mt';
    sites[C] = { routes: {}, robots: 'User-agent: *\nCrawl-delay: 60\n' };
    await add(C);
    await processShopRequests(deps);
    const r = await row(C);
    expect(r).toMatchObject({ status: 'needs_setup', shop_id: null });
    expect(r.error).toMatch(/crawl delay too long for the check/);
  });
});

describe('stored origins', () => {
  it('an origin that is not a valid shop address is refused before anything is fetched', async () => {
    await add('https://localhost');
    const before = probed.length;
    await processShopRequests(deps);
    expect(probed.length).toBe(before);
    expect(await row('https://localhost')).toMatchObject({ status: 'failed', error: expect.stringMatching(/not a valid shop address/) });
  });

  it('the database refuses ports, paths and capitals in an origin', async () => {
    for (const o of ['https://shop.example.mt:8080', 'https://shop.example.mt/x', 'https://Shop.example.mt', 'ftp://shop.example.mt']) {
      await expect(add(o), o).rejects.toThrow(/check constraint/);
    }
  });

  it('one open request per host: www. and the apex are the same shop; a rejected one does not count', async () => {
    await add('https://www.twin.example.mt');
    await expect(add('https://twin.example.mt')).rejects.toThrow(/duplicate key/);
    await pg.query(`update shop_requests set status = 'rejected' where origin = 'https://www.twin.example.mt'`);
    await add('https://twin.example.mt');
  });
});
