// Site-build name matching (design Part 3, "name + specs") on a throwaway PGlite server with the real migrations.
// Runs only with SITE_BUILD_TEST_DB set, like test/site/build.test.ts.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildShop, buildSiteProducts } from '../../src/site/build.js';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';

const PORT = 55463;
// real time: the brand rule reads fresh rows with the database's now()
const NOW = new Date();
const HOUR = 3_600_000;

type Listing = {
  key: string;
  shop: string;
  title: string;
  brand?: string | null;
  gtin?: string | null;
  category?: string;
  /** the clean name; undefined: no product_names row */
  name?: string;
  attrs?: Record<string, unknown>;
  /** source_title differs from the shop title (the shop renamed it since) */
  stale?: boolean;
  /** the clean variant label */
  label?: string;
  /** variant titles: one products row each under the key */
  variants?: string[];
};

const LISTINGS: Listing[] = [
  // the same phone at two shops: titles differ, the clean names agree, the storage too
  { key: 'S25-A', shop: 'alpha', title: 'SAMSUNG Galaxy S25 Ultra 256GB-Storage 12GB Smartphone, Black', brand: 'SAMSUNG', name: 'Samsung Galaxy S25 Ultra Smartphone', attrs: { brand: 'Samsung', storage_gb: 256, ram_gb: 12, colour: ['black'] } },
  { key: 'S25-B', shop: 'beta', title: 'Samsung S25 Ultra 5G (256 GB) Titanium Black', brand: 'Samsung', name: 'Samsung Galaxy S25 Ultra Smartphone', attrs: { storage_gb: 256, colour: ['black'] } },
  // the same clean name, 512GB: another product
  { key: 'S25-512', shop: 'gamma', title: 'Samsung Galaxy S25 Ultra 512GB Grey', brand: 'Samsung', name: 'Samsung Galaxy S25 Ultra Smartphone', attrs: { storage_gb: 512, ram_gb: 12 } },
  // one side does not give the storage
  { key: 'IP16-A', shop: 'alpha', title: 'APPLE iPhone 16 128GB-Storage 8GB Smartphone, Blue', brand: 'APPLE', name: 'Apple iPhone 16 Smartphone', attrs: { storage_gb: 128, ram_gb: 8 } },
  { key: 'IP16-B', shop: 'beta', title: 'Apple iPhone 16 Smartphone Blue', brand: 'Apple', name: 'Apple iPhone 16 Smartphone', attrs: { colour: ['blue'] } },
  // different brands, the same name
  { key: 'CASE-A', shop: 'alpha', title: 'Galaxy S25 Clear Case by Samsung', brand: 'Samsung', name: 'Galaxy S25 Clear Case', attrs: {} },
  { key: 'CASE-B', shop: 'beta', title: 'Spigen Galaxy S25 Clear Case', brand: 'Spigen', name: 'Galaxy S25 Clear Case', attrs: {} },
  // a pack of 6 and a pack of 12
  { key: 'BEER-6', shop: 'alpha', title: 'Heineken Lager 6 x 330ml', brand: 'Heineken', category: 'drinks', name: 'Heineken Lager Beer Can 330ml', attrs: { volume_ml: 330, pack_count: 6 } },
  { key: 'BEER-12', shop: 'beta', title: 'HEINEKEN LAGER CANS 330ML (12 PACK)', brand: 'Heineken', category: 'drinks', name: 'Heineken Lager Beer Can 330ml', attrs: { volume_ml: 330, pack_count: 12 } },
  // a name stored for an older shop title is not used
  { key: 'TAB-A', shop: 'alpha', title: 'Lenovo Tab M11 128GB', brand: 'Lenovo', name: 'Lenovo Tab M11 Tablet', attrs: { storage_gb: 128 } },
  { key: 'TAB-B', shop: 'beta', title: 'Lenovo Tab M11 Tablet 128 GB grey', brand: 'Lenovo', name: 'Lenovo Tab M11 Tablet', attrs: { storage_gb: 128 }, stale: true },
  // a GTIN product at two shops, and a third shop's listing without a GTIN but with the same clean name and specs
  { key: 'BUDS-A', shop: 'alpha', title: 'JBL Tune Buds 2 Black', brand: 'JBL', gtin: '036000291452', category: 'tv-audio', name: 'JBL Tune Buds 2 In-Ear Wireless Earphones', attrs: { colour: ['black'] } },
  { key: 'BUDS-B', shop: 'beta', title: 'JBL TUNE BUDS 2 TWS', brand: 'JBL', gtin: '036000291452', category: 'tv-audio' },
  { key: 'BUDS-G', shop: 'gamma', title: 'JBL Tune Buds 2 earbuds', brand: 'JBL', category: 'tv-audio', name: 'JBL Tune Buds 2 In-Ear Wireless Earphones', attrs: {} },
  // one shop that lists each colour as its own product: one product with two colour options
  { key: 'JBL-BLUE', shop: 'alpha', title: 'JBL Tune 525BT On-Ear Wireless Headphones, Blue', brand: 'JBL', category: 'tv-audio', name: 'JBL Tune 525BT On-Ear Wireless Headphones', attrs: { colour: ['blue'], wireless: 'yes' } },
  { key: 'JBL-WHITE', shop: 'alpha', title: 'JBL Tune 525BT On-Ear Wireless Headphones, White', brand: 'JBL', category: 'tv-audio', name: 'JBL Tune 525BT On-Ear Wireless Headphones', attrs: { colour: ['white'], wireless: 'yes' } },
  // a new game and a pre-owned one; a name stored before the condition rule still has its title
  { key: 'FC-NEW', shop: 'alpha', title: 'Far Cry Instincts (Xbox)', category: 'gaming', name: 'Far Cry Instincts (Xbox)', attrs: { platform: 'multi' } },
  { key: 'FC-USED', shop: 'beta', title: 'Far Cry Instincts (Xbox) (Pre-owned)', category: 'gaming', name: 'Far Cry Instincts (Xbox) (Pre-owned)', attrs: { platform: 'multi' } },
  { key: 'FC-OLD', shop: 'gamma', title: 'Far Cry Instincts (Xbox) (Pre-owned)', category: 'gaming', name: 'Far Cry Instincts (Xbox)', attrs: { platform: 'multi' } },
  // gift cards: two values at one shop, the same value at another
  { key: 'GC-A20', shop: 'alpha', title: 'Steam Gift Card €20', brand: 'Steam', category: 'gaming', name: 'Steam Gift Card', attrs: {} },
  { key: 'GC-A50', shop: 'alpha', title: 'Steam Gift Card €50', brand: 'Steam', category: 'gaming', name: 'Steam Gift Card', attrs: {} },
  { key: 'GC-B50', shop: 'beta', title: 'STEAM GIFT CARD 50 EUR', brand: 'Steam', category: 'gaming', name: 'Steam Gift Card', attrs: {} },
  // a refurbished grade A iPhone and a new one
  { key: 'IP13-R', shop: 'alpha', title: 'Apple iPhone 13 128GB (Refurbished, Grade A)', brand: 'Apple', name: 'Apple iPhone 13 Smartphone', attrs: { storage_gb: 128 } },
  { key: 'IP13-N', shop: 'beta', title: 'Apple iPhone 13 128GB', brand: 'Apple', name: 'Apple iPhone 13 Smartphone', attrs: { storage_gb: 128 } },
  // a 256GB and 512GB group with the storage only in its label, next to the 512GB listing of another shop
  { key: 'S25M', shop: 'beta', title: 'Samsung Galaxy S25 Ultra', brand: 'Samsung', variants: ['256GB', '512GB'], name: 'Samsung Galaxy S25 Ultra Smartphone', label: '256GB, 512GB', attrs: {} },
  { key: 'JBL-BLACK', shop: 'alpha', title: 'JBL Tune 525BT On-Ear Wireless Headphones, Black', brand: 'JBL', category: 'tv-audio', name: 'JBL Tune 525BT On-Ear Wireless Headphones', attrs: { colour: ['black'], wireless: 'yes' } },
  // 256GB and 512GB at one shop: two products
  { key: 'RN-256', shop: 'gamma', title: 'XIAOMI Redmi Note 14 Pro+ 256GB-Storage 8GB Smartphone, Black', brand: 'XIAOMI', name: 'Xiaomi Redmi Note 14 Pro+ Smartphone', attrs: { storage_gb: 256, ram_gb: 8 } },
  { key: 'RN-512', shop: 'gamma', title: 'XIAOMI Redmi Note 14 Pro+ 512GB-Storage 12GB Smartphone, Black', brand: 'XIAOMI', name: 'Xiaomi Redmi Note 14 Pro+ Smartphone', attrs: { storage_gb: 512, ram_gb: 12 } },
];

describe.skipIf(!process.env.SITE_BUILD_TEST_DB)('site-build name matching on PGlite', () => {
  let stop: () => Promise<void> = async () => {};
  let sql: postgres.Sql;
  const shopIds: Record<string, number> = {};

  beforeAll(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
    const pg = await PGlite.create({ dataDir: 'memory://', extensions: { pg_trgm } });
    const server = new PGLiteSocketServer({ db: pg, port: PORT, host: '127.0.0.1', maxConnections: 10 } as never);
    await server.start();
    sql = postgres(`postgres://postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`, { max: 1, onnotice: () => {} });
    stop = async () => {
      await sql.end({ timeout: 5 });
      await server.stop();
      await pg.close();
    };
    const dir = path.resolve('db/migrations');
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) await sql.unsafe(await readFile(path.join(dir, f), 'utf8'));

    for (const slug of ['alpha', 'beta', 'gamma']) {
      shopIds[slug] = (await sql<{ id: number }[]>`
        insert into shops (slug, name, base_url, category, adapter) values (${slug}, ${slug}, ${'https://' + slug + '.test'}, 'electronics', 'woo') returning id`)[0].id;
    }
    const [{ id: runId }] = await sql<{ id: string }[]>`insert into name_runs (model) values ('test') returning id`;
    for (const l of LISTINGS) {
      const path = l.category === 'drinks' ? 'Drinks > Beer' : l.category === 'tv-audio' ? 'Audio > Earphones' : l.category === 'gaming' ? 'Games > Xbox' : 'Mobile Phones';
      // a listing with variants: one products row per variant under the listing's key
      for (const [i, v] of (l.variants ?? [null]).entries()) {
        await sql`
          insert into products (shop_id, external_id, parent_external_id, title, variant_title, brand, gtin, category_path, last_seen)
          values (${shopIds[l.shop]}, ${v === null ? l.key : `${l.key}-${i}`}, ${v === null ? null : l.key}, ${l.title}, ${v}, ${l.brand ?? null}, ${l.gtin ?? null},
            ${path}, ${new Date(NOW.getTime() - HOUR)})`;
      }
      if (l.name === undefined) continue;
      await sql`
        insert into product_names (shop_id, group_key, source_title, title_hash, category, display_name, variant_label, attrs, status, model, run_id)
        values (${shopIds[l.shop]}, ${l.key}, ${l.stale ? 'an older title' : l.title}, 'h', ${l.category ?? 'phones'}, ${l.name}, ${l.label ?? null},
          ${sql.json((l.attrs ?? {}) as postgres.JSONValue)}, 'ok', 'test', ${runId})`;
    }
    // an earlier build title-matched and the admin confirmed the Samsung pair (Ruling R50 applies when it changes)
    await sql`insert into canonical_products (match_key, title) values ('title:1', 'old')`;
    const [{ id: oldCanon }] = await sql<{ id: string }[]>`select id from canonical_products where match_key = 'title:1'`;
    for (const [shop, key] of [['alpha', 'S25-A'], ['beta', 'S25-B']] as const) {
      await sql`
        insert into site_products (shop_id, group_key, title, verdict, canonical_id, match_method, match_confirmed, updated_at)
        values (${shopIds[shop]}, ${key}, 'old', 'none', ${oldCanon}, 'title', true, ${new Date(NOW.getTime() - HOUR)})`;
    }
    await buildSiteProducts(sql, DEFAULT_SETTINGS, NOW);
  }, 120_000);

  afterAll(async () => {
    await stop();
  }, 30_000);

  type Row = { group_key: string; canonical_id: string | null; match_method: string | null; match_confirmed: boolean };
  const rows = async () => new Map((await sql<Row[]>`select group_key, canonical_id, match_method, match_confirmed from site_products`).map((r) => [r.group_key, r]));

  it('matches the same phone at two shops by name, and resets the old confirmation (R50)', async () => {
    const r = await rows();
    expect(r.get('S25-A')).toMatchObject({ match_method: 'name', match_confirmed: false });
    expect(r.get('S25-B')).toMatchObject({ match_method: 'name', match_confirmed: false });
    expect(r.get('S25-A')!.canonical_id).not.toBeNull();
    expect(r.get('S25-A')!.canonical_id).toBe(r.get('S25-B')!.canonical_id);
    const [canon] = await sql`select match_key from canonical_products where id = ${r.get('S25-A')!.canonical_id}`;
    expect(canon.match_key).toMatch(/^name:\d+$/);
  });

  it('keeps 256GB and 512GB apart', async () => {
    const r = await rows();
    expect(r.get('S25-512')!.canonical_id).toBeNull();
  });

  it('matches when one side does not give the storage', async () => {
    const r = await rows();
    expect(r.get('IP16-A')!.match_method).toBe('name');
    expect(r.get('IP16-A')!.canonical_id).toBe(r.get('IP16-B')!.canonical_id);
  });

  it('keeps different brands apart', async () => {
    const r = await rows();
    expect(r.get('CASE-A')!.canonical_id).toBeNull();
    expect(r.get('CASE-B')!.canonical_id).toBeNull();
  });

  it('keeps a pack of 6 and a pack of 12 apart', async () => {
    const r = await rows();
    expect(r.get('BEER-6')!.canonical_id).toBeNull();
    expect(r.get('BEER-12')!.canonical_id).toBeNull();
  });

  it('ignores a clean name stored for an older shop title', async () => {
    const r = await rows();
    expect(r.get('TAB-A')!.canonical_id).toBeNull();
  });

  it('adds a listing without a GTIN to the GTIN product its clean name and specs agree with', async () => {
    const r = await rows();
    expect(r.get('BUDS-A')!.match_method).toBe('gtin');
    expect(r.get('BUDS-B')!.match_method).toBe('gtin');
    expect(r.get('BUDS-G')!.match_method).toBe('name');
    expect(r.get('BUDS-G')!.canonical_id).toBe(r.get('BUDS-A')!.canonical_id);
  });

  it('makes one product of the colours one shop lists on their own', async () => {
    const r = await rows();
    expect(r.get('JBL-BLUE')!.match_method).toBe('name');
    expect(r.get('JBL-BLUE')!.canonical_id).not.toBeNull();
    expect(r.get('JBL-BLUE')!.canonical_id).toBe(r.get('JBL-BLACK')!.canonical_id);
  });

  it('keeps 256GB and 512GB of one shop apart', async () => {
    const r = await rows();
    expect(r.get('RN-256')!.match_method).not.toBe('name');
    expect(r.get('RN-256')!.canonical_id === null || r.get('RN-256')!.canonical_id !== r.get('RN-512')!.canonical_id).toBe(true);
  });

  it('keeps a pre-owned game apart from a new one, also under a name stored before the rule (review C1)', async () => {
    const r = await rows();
    // FC-OLD has the new game's clean name but its title says pre-owned: the two are never one product
    for (const k of ['FC-NEW', 'FC-USED', 'FC-OLD']) expect(r.get(k)!.match_method, k).not.toBe('name');
    expect(r.get('FC-NEW')!.canonical_id).toBeNull();
  });

  it('keeps gift cards of different values apart, at one shop and across shops (review C1)', async () => {
    const r = await rows();
    expect(r.get('GC-A50')!.match_method).toBe('name');
    expect(r.get('GC-A50')!.canonical_id).toBe(r.get('GC-B50')!.canonical_id);
    expect(r.get('GC-A20')!.canonical_id).toBeNull();
  });

  it('keeps a refurbished grade A iPhone apart from a new one (review C1)', async () => {
    const r = await rows();
    expect(r.get('IP13-R')!.canonical_id).toBeNull();
    expect(r.get('IP13-N')!.canonical_id).toBeNull();
  });

  it('never matches a 256GB and 512GB group with a 512GB listing (review C2)', async () => {
    const r = await rows();
    expect(r.get('S25M')!.match_method).not.toBe('name');
    expect(r.get('S25-512')!.match_method).not.toBe('name');
  });

  it('keeps the canonical id of a name group when its first member leaves (review I4)', async () => {
    const before = (await rows()).get('JBL-BLACK')!.canonical_id;
    expect((await rows()).get('JBL-BLUE')!.canonical_id).toBe(before);
    // the shop renames the blue listing: its stored name no longer applies, and its match goes at once
    await sql`update products set title = 'JBL Tune 525BT Blue NEW' where external_id = 'JBL-BLUE'`;
    await buildShop(sql, { id: shopIds.alpha, slug: 'alpha', category: 'electronics' }, DEFAULT_SETTINGS, new Date(NOW.getTime() + 30_000));
    const mid = await rows();
    expect(mid.get('JBL-BLUE')).toMatchObject({ canonical_id: null, match_method: null });
    await buildSiteProducts(sql, DEFAULT_SETTINGS, new Date(NOW.getTime() + 60_000));
    const after = await rows();
    expect(after.get('JBL-BLACK')!.canonical_id).toBe(before);
    expect(after.get('JBL-WHITE')!.canonical_id).toBe(before);
    expect(after.get('JBL-BLUE')!.match_method).not.toBe('name');
  }, 60_000);

  it('records where a removed product went, so its old link can follow (review I4)', async () => {
    const old = (await rows()).get('S25-A')!.canonical_id!;
    await sql`update products set gtin = '4006381333931' where external_id in ('S25-A', 'S25-B')`;
    await buildSiteProducts(sql, DEFAULT_SETTINGS, new Date(NOW.getTime() + 90_000));
    const r = await rows();
    expect(r.get('S25-A')!.match_method).toBe('gtin');
    const now = r.get('S25-A')!.canonical_id!;
    expect(now).not.toBe(old);
    expect(await sql`select id from canonical_products where id = ${old}`).toHaveLength(0);
    const [redirect] = await sql<{ new_id: string }[]>`select new_id from canonical_redirects where old_id = ${old}`;
    expect(redirect.new_id).toBe(now);
  }, 60_000);

  it('keeps the grouping on a rebuild', async () => {
    const before = await rows();
    await buildSiteProducts(sql, DEFAULT_SETTINGS, new Date(NOW.getTime() + 60_000));
    const after = await rows();
    for (const [k, v] of before) expect(after.get(k)?.canonical_id, k).toBe(v.canonical_id);
  }, 60_000);
});
