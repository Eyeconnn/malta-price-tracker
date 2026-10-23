// Site-build name matching by canonical names (design "Update 23 Oct") on a throwaway PGlite server with the real
// migrations. The canonical names are what the normaliser would store: canonicalName() of fixture fields (no Claude
// call). Runs only with SITE_BUILD_TEST_DB set, like test/site/build.test.ts.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalName } from '../../src/names/canonical.js';
import { buildShop, buildSiteProducts } from '../../src/site/build.js';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';

const PORT = 55463;
// real time: the build reads fresh rows with the database's now()
const NOW = new Date();
const HOUR = 3_600_000;
/** name matching is behind a switch, off by default (owner decision 23 Oct) */
const ON = { nameMatching: true };

type Listing = {
  key: string;
  shop: 'alpha' | 'beta' | 'gamma';
  title: string;
  brand?: string | null;
  gtin?: string | null;
  category?: string;
  /** the fields the normaliser stored; undefined: no product_names row */
  fields?: Record<string, unknown>;
  /** a clean name stored before canonical names: no canonical name */
  noCanonical?: boolean;
  /** source_title differs from the shop title (the shop renamed it since) */
  stale?: boolean;
};

const S25 = { brand: 'Samsung', model: 'Galaxy S25 Ultra' };
const JBL = { brand: 'JBL', model: 'Tune 525BT' };

const LISTINGS: Listing[] = [
  // the same phone at two shops, worded and coloured differently
  { key: 'S25-A', shop: 'alpha', title: 'SAMSUNG Galaxy S25 Ultra 256GB-Storage 12GB Smartphone, Black', brand: 'SAMSUNG', fields: { ...S25, storage_gb: 256 } },
  { key: 'S25-B', shop: 'beta', title: 'Samsung S25 Ultra 5G (256 GB) Titanium Black', brand: 'Samsung', fields: { ...S25, storage_gb: 256 } },
  // 512GB: another product
  { key: 'S25-512', shop: 'gamma', title: 'Samsung Galaxy S25 Ultra 512GB Grey', brand: 'Samsung', fields: { ...S25, storage_gb: 512 } },
  // a name saved before canonical names never name-matches
  { key: 'S25-OLD', shop: 'gamma', title: 'Samsung Galaxy S25 Ultra 256GB', brand: 'Samsung', fields: { ...S25, storage_gb: 256 }, noCanonical: true },
  // the colours one shop lists as separate products: one product
  { key: 'JBL-BLUE', shop: 'alpha', title: 'JBL Tune 525BT On-Ear Wireless Headphones, Blue', brand: 'JBL', category: 'tv-audio', fields: { ...JBL, colour: ['blue'] } },
  { key: 'JBL-BLACK', shop: 'alpha', title: 'JBL Tune 525BT On-Ear Wireless Headphones, Black', brand: 'JBL', category: 'tv-audio', fields: { ...JBL, colour: ['black'] } },
  { key: 'JBL-WHITE', shop: 'alpha', title: 'JBL Tune 525BT On-Ear Wireless Headphones, White', brand: 'JBL', category: 'tv-audio', fields: { ...JBL, colour: ['white'] } },
  // whisky: 70cl and 700ml are one volume
  { key: 'JW-A', shop: 'alpha', title: 'Johnnie Walker Black Label 70cl', brand: 'Johnnie Walker', category: 'drinks', fields: { brand: 'Johnnie Walker', line: 'Black Label', volume_ml: 700 } },
  { key: 'JW-B', shop: 'beta', title: 'JOHNNIE WALKER BLACK LABEL WHISKY 700ML', brand: 'Johnnie Walker', category: 'drinks', fields: { brand: 'Johnnie Walker', line: 'Black Label', volume_ml: 700 } },
  // the second guard: equal canonical names, but one shop title says pre-owned
  { key: 'FC-NEW', shop: 'alpha', title: 'Far Cry Instincts (Xbox)', category: 'gaming', fields: { line: 'Far Cry Instincts', platform: 'multi' } },
  { key: 'FC-USED', shop: 'beta', title: 'Far Cry Instincts (Xbox) (Pre-owned)', category: 'gaming', fields: { line: 'Far Cry Instincts', platform: 'multi' } },
  // a name stored for an older shop title is not used
  { key: 'TAB-A', shop: 'alpha', title: 'Lenovo Tab M11 128GB', brand: 'Lenovo', fields: { brand: 'Lenovo', model: 'Tab M11', storage_gb: 128 } },
  { key: 'TAB-B', shop: 'beta', title: 'Lenovo Tab M11 128 GB grey', brand: 'Lenovo', fields: { brand: 'Lenovo', model: 'Tab M11', storage_gb: 128 }, stale: true },
  // a GTIN product at two shops, and a third shop's listing without a GTIN but with the same canonical name
  { key: 'BUDS-A', shop: 'alpha', title: 'JBL Tune Buds 2 Black', brand: 'JBL', gtin: '036000291452', category: 'tv-audio', fields: { brand: 'JBL', model: 'Tune Buds 2' } },
  { key: 'BUDS-B', shop: 'beta', title: 'JBL TUNE BUDS 2 TWS', brand: 'JBL', gtin: '036000291452', category: 'tv-audio' },
  { key: 'BUDS-G', shop: 'gamma', title: 'JBL Tune Buds 2 earbuds', brand: 'JBL', category: 'tv-audio', fields: { brand: 'JBL', model: 'Tune Buds 2' } },
];

describe.skipIf(!process.env.SITE_BUILD_TEST_DB)('site-build name matching by canonical name on PGlite', () => {
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
      const category = l.category ?? 'phones';
      const catPath = category === 'drinks' ? 'Drinks > Spirits' : category === 'tv-audio' ? 'Audio > Earphones' : category === 'gaming' ? 'Games > Xbox' : 'Mobile Phones';
      await sql`
        insert into products (shop_id, external_id, title, brand, gtin, category_path, last_seen)
        values (${shopIds[l.shop]}, ${l.key}, ${l.title}, ${l.brand ?? null}, ${l.gtin ?? null}, ${catPath}, ${new Date(NOW.getTime() - HOUR)})`;
      if (l.fields === undefined) continue;
      const canonical = l.noCanonical ? null : canonicalName(category, l.fields);
      await sql`
        insert into product_names (shop_id, group_key, source_title, title_hash, category, display_name, attrs, canonical_name, status, model, run_id)
        values (${shopIds[l.shop]}, ${l.key}, ${l.stale ? 'an older title' : l.title}, 'h', ${category}, ${l.title}, ${sql.json(l.fields as postgres.JSONValue)},
          ${canonical}, 'ok', 'test', ${runId})`;
    }
    // an earlier build title-matched and the admin confirmed the Samsung pair (Ruling R50 applies when it changes)
    await sql`insert into canonical_products (match_key, title) values ('title:1', 'old')`;
    const [{ id: oldCanon }] = await sql<{ id: string }[]>`select id from canonical_products where match_key = 'title:1'`;
    for (const [shop, key] of [['alpha', 'S25-A'], ['beta', 'S25-B']] as const) {
      await sql`
        insert into site_products (shop_id, group_key, title, verdict, canonical_id, match_method, match_confirmed, updated_at)
        values (${shopIds[shop]}, ${key}, 'old', 'none', ${oldCanon}, 'title', true, ${new Date(NOW.getTime() - HOUR)})`;
    }
    await buildSiteProducts(sql, DEFAULT_SETTINGS, NOW, ON);
  }, 120_000);

  afterAll(async () => {
    await stop();
  }, 30_000);

  type Row = { group_key: string; canonical_id: string | null; match_method: string | null; match_confirmed: boolean };
  const rows = async () => new Map((await sql<Row[]>`select group_key, canonical_id, match_method, match_confirmed from site_products`).map((r) => [r.group_key, r]));
  const same = (r: Map<string, Row>, a: string, b: string) => r.get(a)!.canonical_id !== null && r.get(a)!.canonical_id === r.get(b)!.canonical_id;

  it('matches the same phone at two shops by its canonical name, and resets the old confirmation (R50)', async () => {
    const r = await rows();
    expect(r.get('S25-A')).toMatchObject({ match_method: 'name', match_confirmed: false });
    expect(same(r, 'S25-A', 'S25-B')).toBe(true);
    const [canon] = await sql`select match_key from canonical_products where id = ${r.get('S25-A')!.canonical_id}`;
    expect(canon.match_key).toMatch(/^name:\d+$/);
  });

  it('keeps 256GB and 512GB apart, and never matches a name without a canonical name', async () => {
    const r = await rows();
    expect(r.get('S25-512')!.match_method).not.toBe('name');
    expect(same(r, 'S25-A', 'S25-512')).toBe(false);
    expect(r.get('S25-OLD')!.match_method).not.toBe('name');
  });

  it('makes one product of the colours one shop lists on their own', async () => {
    const r = await rows();
    expect(r.get('JBL-BLUE')!.match_method).toBe('name');
    expect(same(r, 'JBL-BLUE', 'JBL-BLACK') && same(r, 'JBL-BLUE', 'JBL-WHITE')).toBe(true);
  });

  it('matches 70cl and 700ml of one whisky', async () => {
    expect(same(await rows(), 'JW-A', 'JW-B')).toBe(true);
  });

  it('keeps a pre-owned game apart from a new one with the same canonical name (the second guard)', async () => {
    const r = await rows();
    expect(r.get('FC-NEW')!.match_method).not.toBe('name');
    expect(r.get('FC-USED')!.match_method).not.toBe('name');
  });

  it('ignores a canonical name stored for an older shop title', async () => {
    expect((await rows()).get('TAB-A')!.match_method).not.toBe('name');
  });

  it('adds a listing without a GTIN to the GTIN product whose named listings share its canonical name', async () => {
    const r = await rows();
    expect(r.get('BUDS-A')!.match_method).toBe('gtin');
    expect(r.get('BUDS-G')!.match_method).toBe('name');
    expect(same(r, 'BUDS-G', 'BUDS-A')).toBe(true);
  });

  it('keeps the canonical id of a name group when its first member leaves (review I4)', async () => {
    const before = (await rows()).get('JBL-BLACK')!.canonical_id;
    // the shop renames the blue listing: its stored name no longer applies, and its match goes at once
    await sql`update products set title = 'JBL Tune 525BT Blue NEW' where external_id = 'JBL-BLUE'`;
    await buildShop(sql, { id: shopIds.alpha, slug: 'alpha', category: 'electronics' }, DEFAULT_SETTINGS, new Date(NOW.getTime() + 30_000));
    expect((await rows()).get('JBL-BLUE')).toMatchObject({ canonical_id: null, match_method: null });
    await buildSiteProducts(sql, DEFAULT_SETTINGS, new Date(NOW.getTime() + 60_000), ON);
    const after = await rows();
    expect(after.get('JBL-BLACK')!.canonical_id).toBe(before);
    expect(after.get('JBL-WHITE')!.canonical_id).toBe(before);
    expect(after.get('JBL-BLUE')!.match_method).not.toBe('name');
  }, 60_000);

  it('records where a removed product went, so its old link can follow (review I4)', async () => {
    const old = (await rows()).get('S25-A')!.canonical_id!;
    await sql`update products set gtin = '4006381333931' where external_id in ('S25-A', 'S25-B')`;
    await buildSiteProducts(sql, DEFAULT_SETTINGS, new Date(NOW.getTime() + 90_000), ON);
    const r = await rows();
    expect(r.get('S25-A')!.match_method).toBe('gtin');
    const now = r.get('S25-A')!.canonical_id!;
    expect(now).not.toBe(old);
    expect(await sql`select id from canonical_products where id = ${old}`).toHaveLength(0);
    const [redirect] = await sql<{ new_id: string }[]>`select new_id from canonical_redirects where old_id = ${old}`;
    expect(redirect.new_id).toBe(now);
  }, 60_000);

  it('groups nothing by name while the switch is off (the default), and keeps barcode matches', async () => {
    const before = await rows();
    const gtin = [...before].filter(([, r]) => r.match_method === 'gtin');
    expect(gtin.length).toBeGreaterThan(0);
    await buildSiteProducts(sql, DEFAULT_SETTINGS, new Date(NOW.getTime() + 120_000));
    const after = await rows();
    expect([...after.values()].filter((r) => r.match_method === 'name')).toEqual([]);
    for (const [k, r] of gtin) expect(after.get(k), k).toMatchObject({ match_method: 'gtin', canonical_id: r.canonical_id });
  }, 60_000);
});
