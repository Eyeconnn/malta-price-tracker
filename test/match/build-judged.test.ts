// Site-build match method judged (design "Update 23 Oct, afternoon", point 4) on a throwaway PGlite server with the
// real migrations: stored judgements whose fingerprint is current and which the veto does not overrule form canonical
// groups; GTIN groups keep priority and are never merged; stable keys, R50 reset and redirects as for other methods;
// the JUDGED_MATCHING switch is off by default. Runs only with SITE_BUILD_TEST_DB set.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidateKey, fingerprint } from '../../src/match/fingerprint.js';
import { buildSiteProducts } from '../../src/site/build.js';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';

const PORT = 55472;
const NOW = new Date();
const HOUR = 3_600_000;
const ON = { judgedMatching: true };

type Listing = { key: string; shop: 'alpha' | 'beta' | 'gamma'; title: string; gtin?: string; path?: string; brand?: string };
const LISTINGS: Listing[] = [
  { key: 'S23-A', shop: 'alpha', title: 'Samsung Galaxy S23 256GB Phantom Black', brand: 'Samsung' },
  { key: 'S23-B', shop: 'beta', title: 'SAMSUNG Galaxy S23 256GB Black', brand: 'Samsung' },
  { key: 'S23-G', shop: 'gamma', title: 'Samsung Galaxy S23 256GB Cream', brand: 'Samsung' },
  { key: 'IP15', shop: 'alpha', title: 'Apple iPhone 15 128GB', brand: 'Apple' },
  { key: 'IP15P', shop: 'beta', title: 'Apple iPhone 15 Plus 128GB', brand: 'Apple' },
  { key: 'BUDS-A', shop: 'alpha', title: 'JBL Tune Buds 2 Black', gtin: '036000291452', path: 'Audio > Earphones', brand: 'JBL' },
  { key: 'BUDS-B', shop: 'beta', title: 'JBL TUNE BUDS 2 TWS', gtin: '036000291452', path: 'Audio > Earphones', brand: 'JBL' },
  { key: 'BUDS-G', shop: 'gamma', title: 'JBL Tune Buds 2 earbuds', path: 'Audio > Earphones', brand: 'JBL' },
  { key: 'X-A', shop: 'alpha', title: 'Wombat Router AX3000', gtin: '4006381333931' },
  { key: 'X-B', shop: 'beta', title: 'Wombat Router AX3000 WiFi', gtin: '4006381333931' },
  { key: 'Y-A', shop: 'alpha', title: 'Wombat Router AX3000 v2', gtin: '5901234123457' },
  { key: 'Y-B', shop: 'beta', title: 'WOMBAT ROUTER AX3000 V2', gtin: '5901234123457' },
  { key: 'TAB-A', shop: 'alpha', title: 'Lenovo Tab M11 128GB', brand: 'Lenovo' },
  { key: 'TAB-B', shop: 'beta', title: 'Lenovo Tab M11 128 GB grey', brand: 'Lenovo' },
  { key: 'JBL-BLUE', shop: 'alpha', title: 'JBL Tune 525BT On-Ear Headphones, Blue', path: 'Audio > Headphones', brand: 'JBL' },
  { key: 'JBL-BLACK', shop: 'alpha', title: 'JBL Tune 525BT On-Ear Headphones, Black', path: 'Audio > Headphones', brand: 'JBL' },
];

describe.skipIf(!process.env.SITE_BUILD_TEST_DB)('site-build judged matching on PGlite', () => {
  let stop: () => Promise<void> = async () => {};
  let sql: postgres.Sql;
  const shopIds: Record<string, number> = {};
  let runId = 0;
  const byKey = new Map(LISTINGS.map((l) => [l.key, l]));
  const member = (key: string, title?: string) => ({ shopId: shopIds[byKey.get(key)!.shop], groupKey: key, title: title ?? byKey.get(key)!.title, variantTitles: [] as string[] });

  /** Stores Claude's (simulated) clusters for the listings, with the fingerprint of the given titles. */
  async function judge(keys: string[], clusters: number[][], titles: Record<string, string> = {}) {
    const ms = keys.map((k) => member(k, titles[k]));
    await sql`
      insert into match_judgements (candidate_key, members, fingerprint, verdict, model, effort, run_id)
      values (${candidateKey(ms)}, ${sql.json(ms.map((m) => ({ shop_id: m.shopId, group_key: m.groupKey, site_product_id: 0 })))},
        ${fingerprint(ms)}, ${sql.json({ clusters, apart: [], vetoed: [], final: clusters })}, 'haiku', 'low', ${runId})
      on conflict (candidate_key) do update set fingerprint = excluded.fingerprint, verdict = excluded.verdict, judged_at = now()`;
  }

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
    for (const l of LISTINGS) {
      await sql`
        insert into products (shop_id, external_id, title, brand, gtin, category_path, last_seen)
        values (${shopIds[l.shop]}, ${l.key}, ${l.title}, ${l.brand ?? null}, ${l.gtin ?? null}, ${l.path ?? 'Mobile Phones'}, ${new Date(NOW.getTime() - HOUR)})`;
    }
    runId = Number((await sql<{ id: string }[]>`insert into judge_runs (model) values ('haiku') returning id`)[0].id);
    // an earlier build title-matched and the admin confirmed the Samsung pair (Ruling R50 applies when it changes)
    const [{ id: oldCanon }] = await sql<{ id: string }[]>`insert into canonical_products (match_key, title) values ('title:1', 'old') returning id`;
    for (const [shop, key] of [['alpha', 'S23-A'], ['beta', 'S23-B']] as const) {
      await sql`
        insert into site_products (shop_id, group_key, title, verdict, canonical_id, match_method, match_confirmed, updated_at)
        values (${shopIds[shop]}, ${key}, 'old', 'none', ${oldCanon}, 'title', true, ${new Date(NOW.getTime() - HOUR)})`;
    }

    await judge(['S23-A', 'S23-B'], [[0, 1]]);
    // Claude (simulated) calls the iPhone 15 and 15 Plus the same: the veto keeps them apart
    await judge(['IP15', 'IP15P'], [[0, 1]]);
    await judge(['BUDS-A', 'BUDS-B', 'BUDS-G'], [[0, 1, 2]]);
    await judge(['X-A', 'X-B', 'Y-A', 'Y-B'], [[0, 1, 2, 3]]);
    // judged for an older title of TAB-B: not current
    await judge(['TAB-A', 'TAB-B'], [[0, 1]], { 'TAB-B': 'Lenovo Tab M11 128GB' });
    await judge(['JBL-BLUE', 'JBL-BLACK'], [[0, 1]]);
  }, 120_000);

  afterAll(async () => {
    await stop();
  }, 30_000);

  type Row = { group_key: string; canonical_id: string | null; match_method: string | null; match_confirmed: boolean };
  const rows = async () => new Map((await sql<Row[]>`select group_key, canonical_id, match_method, match_confirmed from site_products`).map((r) => [r.group_key, r]));
  const same = (r: Map<string, Row>, a: string, b: string) => r.get(a)!.canonical_id !== null && r.get(a)!.canonical_id === r.get(b)!.canonical_id;
  const lines: string[] = [];
  const build = (opts: { judgedMatching?: boolean } = ON) => buildSiteProducts(sql, DEFAULT_SETTINGS, NOW, { ...opts, log: (l) => lines.push(l) });

  it('leaves judged matching off by default', async () => {
    await build({});
    const r = await rows();
    expect([...r.values()].some((x) => x.match_method === 'judged')).toBe(false);
  });

  it('groups a current judgement as method judged, keyed judged:<id>, and resets the old confirmation (R50)', async () => {
    await build();
    const r = await rows();
    expect(r.get('S23-A')).toMatchObject({ match_method: 'judged', match_confirmed: false });
    expect(same(r, 'S23-A', 'S23-B')).toBe(true);
    const [canon] = await sql`select match_key from canonical_products where id = ${r.get('S23-A')!.canonical_id}`;
    expect(canon.match_key).toMatch(/^judged:\d+$/);
    expect(lines.some((l) => /^judged matching: 6 judgements, 5 current, 1 stale/.test(l))).toBe(true);
  });

  it('applies the veto again: iPhone 15 and 15 Plus stay apart', async () => {
    const r = await rows();
    expect(r.get('IP15')!.match_method).not.toBe('judged');
    expect(same(r, 'IP15', 'IP15P')).toBe(false);
  });

  it('adds a judged listing to the one GTIN group, and never merges two GTIN groups', async () => {
    const r = await rows();
    expect(r.get('BUDS-A')!.match_method).toBe('gtin');
    expect(r.get('BUDS-G')!.match_method).toBe('judged');
    expect(same(r, 'BUDS-A', 'BUDS-G')).toBe(true);
    expect(r.get('X-A')!.match_method).toBe('gtin');
    expect(r.get('Y-A')!.match_method).toBe('gtin');
    expect(same(r, 'X-A', 'Y-A')).toBe(false);
  });

  it('ignores a judgement made for an older title, and groups the colours one shop lists on their own', async () => {
    const r = await rows();
    expect(r.get('TAB-A')!.match_method).not.toBe('judged');
    expect(same(r, 'JBL-BLUE', 'JBL-BLACK')).toBe(true);
    expect(r.get('JBL-BLUE')!.match_method).toBe('judged');
  });

  it('keeps the product link when the group re-forms with another first member (stable keys)', async () => {
    const before = (await rows()).get('S23-B')!.canonical_id;
    // S23-A is renamed by its shop, so its judgement is stale; a newer judgement groups S23-B with S23-G
    await sql`update products set title = 'Samsung Galaxy S23 FE 256GB' where external_id = 'S23-A'`;
    await judge(['S23-B', 'S23-G'], [[0, 1]]);
    await build();
    const r = await rows();
    expect(r.get('S23-B')!.match_method).toBe('judged');
    expect(same(r, 'S23-B', 'S23-G')).toBe(true);
    expect(r.get('S23-B')!.canonical_id).toBe(before);
    expect(r.get('S23-A')!.canonical_id).not.toBe(before);
  });

  it('switched off again, judged groups go and their old link redirects to where the listings went', async () => {
    const r0 = await rows();
    const judgedCanon = r0.get('JBL-BLUE')!.canonical_id;
    await build({ judgedMatching: false });
    const r = await rows();
    expect([...r.values()].some((x) => x.match_method === 'judged')).toBe(false);
    const gone = await sql`select id from canonical_products where id = ${judgedCanon}`;
    expect(gone).toHaveLength(0);
    // S23-B and S23-G now only title-match: the judged product's link follows them
    const s23 = r0.get('S23-B')!.canonical_id;
    expect(r.get('S23-B')!.match_method).toBe('title');
    expect(r.get('S23-B')!.canonical_id).not.toBe(s23);
    const [red] = await sql`select new_id from canonical_redirects where old_id = ${s23}`;
    expect(red.new_id).toBe(r.get('S23-B')!.canonical_id);
  });
});
