// The PC task (src/shop-requests/process.ts) on PGlite with every migration applied: requests move from pending
// through checking to their outcome; a passing shop is created inactive, test-scraped, then activated.
// Detection runs for real against recorded responses (fake-fetcher.ts); the test scrape is a stand-in.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunTotals } from '../../src/pipeline/store.js';
import { PROBE_PATHS, probeShop } from '../../src/shop-requests/detect.js';
import { type Db, type ProcessDeps, processShopRequests } from '../../src/shop-requests/process.js';
import type { NormalisedRecord, Shop } from '../../src/types.js';
import { blankRecord } from '../../src/util/normalise.js';
import { type Recorded, fakeFetcher, fixture } from './fake-fetcher.js';

let pg: PGlite;
const db: Db = { query: async (text, params = []) => (await pg.query<Record<string, unknown>>(text, params)).rows as never };

const SHOPIFY = 'https://shop.example.mt';
const NAMED = 'https://named.example.mt';
const UNKNOWN = 'https://fashion.example.mt';
const BLOCKED = 'https://closed.example.mt';
const THIN = 'https://thin.example.mt';
const CRASH = 'https://crash.example.mt';
const TAKEN = 'https://www.klikk.com.mt';

const shopifySite = (o: string): Record<string, Recorded> => ({
  [`${o}/`]: { body: fixture('shopify-home.html') },
  [`${o}${PROBE_PATHS.shopify}`]: { body: fixture('shopify-products.json') },
});
const SITES: Record<string, { routes: Record<string, Recorded>; robots?: string }> = {
  [SHOPIFY]: { routes: shopifySite(SHOPIFY) },
  [NAMED]: { routes: shopifySite(NAMED) },
  [THIN]: { routes: shopifySite(THIN) },
  [TAKEN]: { routes: shopifySite(TAKEN) },
  [UNKNOWN]: { routes: { [`${UNKNOWN}/`]: { body: fixture('unknown-home.html'), headers: { server: 'nginx' } } } },
  [BLOCKED]: { routes: shopifySite(BLOCKED), robots: 'User-agent: *\nCrawl-delay: 4\nDisallow: /products.json\n' },
};

const rec = (i: number): NormalisedRecord => ({ ...blankRecord(String(i)), title: `Robot ${i}`, price_cents: 3999 + i, url: `https://shop.example.mt/products/r${i}` });
const totals = (over: Partial<RunTotals>): RunTotals => ({ status: 'ok', products_seen: 0, requests: 3, failed_requests: 0, disallowed: 0, errors: 0, error_log: [], notes: null, ...over });

type Seen = { origin: string; requestStatus: string; shopActive: boolean; shop: Shop };
/** the activation hook's calls: the shop's slug, whether it was active then, and the crawl delay it was given */
const logoCalls: { slug: string; active: boolean; dbActive: boolean; crawlDelay: number | undefined; inLock: boolean }[] = [];
/** true while processShopRequests holds its run lock */
let inLock = false;

function deps(seen: Seen[], probed: string[], over: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    db,
    withLock: async (fn) => {
      inLock = true;
      try {
        await fn();
      } finally {
        inLock = false;
      }
      return true;
    },
    probe: async (origin) => {
      probed.push(origin);
      if (origin === CRASH) throw new Error('socket hang up');
      const site = SITES[origin]!;
      const f = fakeFetcher(origin, site.routes, site.robots ? { [origin]: site.robots } : {});
      return probeShop(f, origin);
    },
    testScrape: async (shop) => {
      const [r] = (await pg.query<{ status: string; active: boolean }>(
        'select r.status, s.active from shop_requests r join shops s on s.id = r.shop_id where s.id = $1',
        [shop.id],
      )).rows;
      seen.push({ origin: shop.base_url, requestStatus: r!.status, shopActive: r!.active, shop });
      if (shop.base_url === THIN) return { totals: totals({ products_seen: 4, requests: 2 }), sample: [1, 2, 3, 4].map(rec) };
      return { totals: totals({ products_seen: 50, requests: 3 }), sample: Array.from({ length: 50 }, (_, i) => rec(i)) };
    },
    reservedSlugs: new Set(['shop-example']),
    fetchLogo: async (shop, det) => {
      const [row] = (await pg.query<{ active: boolean }>('select active from shops where id = $1', [shop.id])).rows;
      logoCalls.push({ slug: shop.slug, active: shop.active, dbActive: row!.active, crawlDelay: det.kind === 'supported' ? det.robots.crawlDelaySeconds : undefined, inLock });
    },
    log: () => {},
    ...over,
  };
}

const request = async (origin: string) =>
  (await pg.query<Record<string, unknown>>('select * from shop_requests where origin = $1 order by id desc limit 1', [origin])).rows[0]!;
const shopById = async (id: unknown) => (await pg.query<Record<string, unknown>>('select * from shops where id = $1', [id])).rows[0]!;

beforeAll(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  pg = await PGlite.create({ dataDir: 'memory://', extensions: { pg_trgm } });
  const dir = path.resolve('db/migrations');
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(await readFile(path.join(dir, f), 'utf8'));
  await pg.exec(`
    insert into shops (slug, name, base_url, adapter, active) values ('klikk', 'Klikk', 'https://www.klikk.com.mt', 'shopify', true);
    insert into shop_requests (origin, display_name, shop_category, status, requested_at, started_at) values
      ('${UNKNOWN}', null, 'fashion', 'pending', now() - interval '50 minutes', null),
      ('${SHOPIFY}', null, 'toys', 'pending', now() - interval '60 minutes', null),
      ('${NAMED}', 'My  Named Shop', null, 'pending', now() - interval '40 minutes', null),
      ('${BLOCKED}', null, null, 'pending', now() - interval '30 minutes', null),
      ('${THIN}', null, null, 'pending', now() - interval '20 minutes', null),
      ('${CRASH}', null, null, 'pending', now() - interval '10 minutes', null),
      ('${TAKEN}', null, null, 'pending', now() - interval '5 minutes', null),
      ('https://rejected.example.mt', null, null, 'rejected', now() - interval '70 minutes', null),
      ('https://stuck.example.mt', null, null, 'checking', now() - interval '3 hours', now() - interval '2 hours'),
      ('https://busy.example.mt', null, null, 'checking', now() - interval '20 minutes', now() - interval '10 minutes');
  `);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('processShopRequests', () => {
  it('does nothing when another run holds the lock', async () => {
    const probed: string[] = [];
    const out = await processShopRequests(deps([], probed, { withLock: async () => false }));
    expect(out.ran).toBe(false);
    expect(probed).toEqual([]);
    expect((await request(SHOPIFY)).status).toBe('pending');
    expect((await request('https://stuck.example.mt')).status).toBe('checking');
  });

  const seen: Seen[] = [];
  const probed: string[] = [];

  it('checks every pending request once, oldest first, and leaves rejected ones alone', async () => {
    const out = await processShopRequests(deps(seen, probed));
    expect(out.ran).toBe(true);
    // the host that is already a shop is refused before anything is fetched
    expect(probed).toEqual([SHOPIFY, UNKNOWN, NAMED, BLOCKED, THIN, CRASH]);
    expect((await request('https://rejected.example.mt')).status).toBe('rejected');
    for (const o of [SHOPIFY, UNKNOWN, NAMED, BLOCKED, THIN, CRASH, TAKEN]) {
      const r = await request(o);
      expect(Number(r.attempts), o).toBe(1);
      expect(r.checked_at, o).not.toBeNull();
      expect(r.started_at, o).not.toBeNull();
    }
  });

  it('a passing Shopify shop: created inactive with runner local and tier P2 while checking, then activated', async () => {
    const during = seen.find((s) => s.origin === SHOPIFY)!;
    expect(during).toMatchObject({ requestStatus: 'checking', shopActive: false });
    expect(during.shop).toMatchObject({ adapter: 'shopify', tier: 'P2', active: false, config: { runner: 'local' } });
    const r = await request(SHOPIFY);
    expect(r).toMatchObject({ status: 'active', platform: 'shopify', products_found: 50, error: null });
    expect(r.robots).toMatchObject({ allowed: true, crawlDelaySeconds: 0 });
    expect((r.sample as unknown[]).length).toBe(10);
    expect((r.sample as unknown[])[0]).toEqual({ title: 'Robot 0', priceCents: 3999, url: 'https://shop.example.mt/products/r0' });
    const shop = await shopById(r.shop_id);
    // "shop-example" is taken in shops.seed.json, so the slug gets a number; the name comes from og:site_name
    expect(shop).toMatchObject({ slug: 'shop-example-2', name: 'Tech & Toys Malta', base_url: SHOPIFY, category: 'toys', adapter: 'shopify', tier: 'P2', active: true });
    expect(shop.config).toEqual({ runner: 'local' });
  });

  it('fetches the logo once for each shop it activated, after the run lock is released, and for no other', () => {
    expect(logoCalls).toEqual([
      { slug: 'shop-example-2', active: true, dbActive: true, crawlDelay: 0, inLock: false },
      { slug: 'named-example', active: true, dbActive: true, crawlDelay: 0, inLock: false },
    ]);
  });

  it('the name typed in the form wins over the site name', async () => {
    const shop = await shopById((await request(NAMED)).shop_id);
    expect(shop).toMatchObject({ slug: 'named-example', name: 'My Named Shop', active: true });
  });

  it('an unknown platform needs setup, with what was found, and no shop is created', async () => {
    const r = await request(UNKNOWN);
    expect(r).toMatchObject({ status: 'needs_setup', platform: 'unknown', shop_id: null });
    expect(r.details).toMatchObject({ server: 'nginx', generator: ['PrestaShop'] });
    expect(r.error).toMatch(/not Shopify, WooCommerce or Magento/);
  });

  it('robots.txt blocking the feed: blocked with the rule, crawl delay recorded, no shop', async () => {
    const r = await request(BLOCKED);
    expect(r).toMatchObject({ status: 'blocked', platform: 'shopify', shop_id: null });
    expect(r.error).toMatch(/Disallow: \/products\.json \(line 3\)/);
    expect(r.robots).toMatchObject({ allowed: false, crawlDelaySeconds: 4 });
  });

  it('a thin test scrape fails with the reason; its shop stays inactive', async () => {
    const r = await request(THIN);
    expect(r).toMatchObject({ status: 'failed', products_found: 4 });
    expect(r.error).toMatch(/Only 4 products/);
    expect((await shopById(r.shop_id)).active).toBe(false);
  });

  it('a crash leaves the request failed with the error, never checking', async () => {
    const r = await request(CRASH);
    expect(r).toMatchObject({ status: 'failed', error: 'The check stopped with an error: socket hang up' });
  });

  it('a host that is already a shop fails without creating another', async () => {
    const r = await request(TAKEN);
    expect(r).toMatchObject({ status: 'failed', shop_id: null });
    expect(r.error).toMatch(/already a shop \(klikk\)/);
    expect(Number((await pg.query<{ n: number }>(`select count(*)::int as n from shops where base_url like '%klikk%'`)).rows[0]!.n)).toBe(1);
  });

  it('a request stuck in checking for over an hour becomes failed; a recent one is left alone', async () => {
    expect(await request('https://stuck.example.mt')).toMatchObject({ status: 'failed', error: expect.stringMatching(/interrupted/) });
    expect((await request('https://busy.example.mt')).status).toBe('checking');
  });

  it('a retry reuses the shop it created and counts the attempt', async () => {
    const before = await request(THIN);
    await pg.query(`update shop_requests set status = 'pending' where id = $1`, [before.id]);
    const shops = Number((await pg.query<{ n: number }>('select count(*)::int as n from shops')).rows[0]!.n);
    const again: Seen[] = [];
    await processShopRequests(
      deps(again, [], {
        testScrape: async () => ({ totals: totals({ products_seen: 50 }), sample: Array.from({ length: 50 }, (_, i) => rec(i)) }),
      }),
    );
    const r = await request(THIN);
    expect(r).toMatchObject({ status: 'active', error: null, shop_id: before.shop_id });
    expect(logoCalls.at(-1)).toMatchObject({ slug: (await shopById(r.shop_id)).slug, dbActive: true });
    expect(Number(r.attempts)).toBe(2);
    expect(Number((await pg.query<{ n: number }>('select count(*)::int as n from shops')).rows[0]!.n)).toBe(shops);
    expect((await shopById(r.shop_id)).active).toBe(true);
  });

  it('a request rejected while it was being checked stays rejected and its shop inactive', async () => {
    await pg.query(`insert into shop_requests (origin, status) values ('https://late.example.mt', 'pending')`);
    SITES['https://late.example.mt'] = { routes: shopifySite('https://late.example.mt') };
    await processShopRequests(
      deps([], [], {
        testScrape: async () => {
          await pg.query(`update shop_requests set status = 'rejected' where origin = 'https://late.example.mt'`);
          return { totals: totals({ products_seen: 50 }), sample: Array.from({ length: 50 }, (_, i) => rec(i)) };
        },
      }),
    );
    const r = await request('https://late.example.mt');
    expect(r.status).toBe('rejected');
    expect((await shopById(r.shop_id)).active).toBe(false);
    expect(logoCalls.map((c) => c.slug)).not.toContain((await shopById(r.shop_id)).slug);
  });

  it('a failing logo fetch is logged and never undoes the activation', async () => {
    await pg.query(`insert into shop_requests (origin, status) values ('https://nologo.example.mt', 'pending')`);
    SITES['https://nologo.example.mt'] = { routes: shopifySite('https://nologo.example.mt') };
    const logged: string[] = [];
    let calls = 0;
    await processShopRequests(
      deps([], [], {
        fetchLogo: async () => {
          calls++;
          throw new Error('R2 down');
        },
        log: (m) => logged.push(m),
      }),
    );
    const r = await request('https://nologo.example.mt');
    expect(calls).toBe(1);
    expect(r.status).toBe('active');
    expect((await shopById(r.shop_id)).active).toBe(true);
    expect(logged).toContain('https://nologo.example.mt: logo not fetched: R2 down');
  });

  it("stops a logo fetch at its deadline, aborting its signal, and goes on", async () => {
    await pg.query(`insert into shop_requests (origin, status) values ('https://hang.example.mt', 'pending')`);
    SITES['https://hang.example.mt'] = { routes: shopifySite('https://hang.example.mt') };
    const logged: string[] = [];
    let seen: AbortSignal | undefined;
    const started = Date.now();
    await processShopRequests(
      deps([], [], {
        logoDeadlineMs: 50,
        fetchLogo: (_shop, _det, signal) => {
          seen = signal;
          // never ends on its own
          return new Promise<void>(() => {});
        },
        log: (m) => logged.push(m),
      }),
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(seen?.aborted).toBe(true);
    expect(logged).toContain('https://hang.example.mt: logo fetch stopped at the 0 s deadline');
    expect((await request('https://hang.example.mt')).status).toBe('active');
  });
});
