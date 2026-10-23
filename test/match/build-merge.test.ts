// A merge-pass judgement at the site build, on a throwaway PGlite server with the real migrations: one model judged
// in two chunks makes two judged products; the merge judgement (newer, key "m...", every member) makes them one
// product that keeps the larger one's link, the other link redirects to it, and the chunk judgements stay stored.
// A later normal judgement sharing a listing removes the merge. Runs only with SITE_BUILD_TEST_DB set.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidateKey, fingerprint, normText } from '../../src/match/fingerprint.js';
import { loadJudgements, saveJudgements, supersedeJudgements, type JudgementRow } from '../../src/match/store.js';
import { buildSiteProducts } from '../../src/site/build.js';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';

const PORT = 55473;
const NOW = new Date();
const HOUR = 3_600_000;

type L = { key: string; shop: 'alpha' | 'beta' | 'gamma'; title: string };
const LISTINGS: L[] = [
  { key: 'A-S', shop: 'alpha', title: 'APPLE iPhone 17 Pro 512GB-Storage 12GB Smartphone, Silver' },
  { key: 'A-B', shop: 'alpha', title: 'APPLE iPhone 17 Pro 512GB-Storage 12GB Smartphone, Blue' },
  { key: 'B-O', shop: 'beta', title: 'APPLE IPHONE 17 PRO 512GB ORANGE' },
  { key: 'B-DB', shop: 'beta', title: 'APPLE IPHONE 17 PRO 512GB DEEP BLUE' },
  { key: 'G-S', shop: 'gamma', title: 'Apple iPhone 17 Pro 512GB Silver' },
  { key: 'G-DB', shop: 'gamma', title: 'Apple Iphone 17 Pro 512GB Deep Blue' },
];

describe.skipIf(!process.env.SITE_BUILD_TEST_DB)('site-build with a merge-pass judgement on PGlite', () => {
  let stop: () => Promise<void> = async () => {};
  let sql: postgres.Sql;
  const shopIds: Record<string, number> = {};
  let runId = 0;
  const byKey = new Map(LISTINGS.map((l) => [l.key, l]));

  function row(prefix: 'c' | 'm', keys: string[], clusters: number[][]): JudgementRow {
    const ms = keys.map((k) => ({ shopId: shopIds[byKey.get(k)!.shop], groupKey: k, title: byKey.get(k)!.title, variantTitles: [] as string[] }));
    return {
      key: `${prefix}${candidateKey(ms).slice(1)}`, fingerprint: fingerprint(ms), model: 'haiku', effort: 'low',
      members: ms.map((m) => ({ shop_id: m.shopId, group_key: m.groupKey, site_product_id: 0, title: normText(m.title), variants: [] })),
      verdict: { clusters, apart: [], vetoed: [], final: clusters.filter((c) => c.length > 1), ...(prefix === 'm' ? { merge: { sources: [] } } : {}) },
    };
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
        insert into products (shop_id, external_id, title, brand, category_path, last_seen)
        values (${shopIds[l.shop]}, ${l.key}, ${l.title}, 'Apple', 'Mobile Phones', ${new Date(NOW.getTime() - HOUR)})`;
    }
    runId = Number((await sql<{ id: string }[]>`insert into judge_runs (model) values ('haiku') returning id`)[0].id);
    // the live split: one model judged in two chunks
    await saveJudgements(sql, runId, [row('c', ['A-S', 'A-B', 'B-O', 'G-S'], [[0, 1, 2, 3]]), row('c', ['B-DB', 'G-DB'], [[0, 1]])]);
  }, 120_000);

  afterAll(async () => {
    await stop();
  }, 30_000);

  type Row = { group_key: string; canonical_id: string | null; match_method: string | null };
  const rows = async () => new Map((await sql<Row[]>`select group_key, canonical_id, match_method from site_products`).map((r) => [r.group_key, r]));
  const products = (r: Map<string, Row>) => new Set(LISTINGS.map((l) => r.get(l.key)!.canonical_id));
  const build = () => buildSiteProducts(sql, DEFAULT_SETTINGS, NOW, { judgedMatching: true, log: () => {} });

  it('makes two judged products of the two chunks', async () => {
    await build();
    const r = await rows();
    expect([...r.values()].every((x) => x.match_method === 'judged')).toBe(true);
    expect(products(r).size).toBe(2);
  });

  it('makes one product after the merge, keeping the larger link and redirecting the other', async () => {
    const before = await rows();
    const big = before.get('A-S')!.canonical_id;
    const small = before.get('B-DB')!.canonical_id;
    const merge = row('m', ['A-S', 'A-B', 'B-O', 'G-S', 'B-DB', 'G-DB'], [[0, 1, 2, 3, 4, 5]]);
    expect(await saveJudgements(sql, runId, [merge])).toEqual({ saved: 1 });
    expect(await supersedeJudgements(sql, { complete: true })).toBe(0);
    // the chunk judgements stay
    expect((await loadJudgements(sql)).map((j) => j.key[0]).sort()).toEqual(['c', 'c', 'm']);
    await build();
    const r = await rows();
    expect(products(r)).toEqual(new Set([big]));
    expect(r.get('B-DB')!.match_method).toBe('judged');
    const [red] = await sql`select new_id from canonical_redirects where old_id = ${small}`;
    expect(red.new_id).toBe(big);
  });

  it('a later normal judgement sharing a listing removes the merge judgement when the run is superseded', async () => {
    await saveJudgements(sql, runId, [row('c', ['B-DB', 'G-DB'], [[0], [1]])]);
    expect(await supersedeJudgements(sql, { complete: true })).toBe(1);
    expect((await loadJudgements(sql)).map((j) => j.key[0]).sort()).toEqual(['c', 'c']);
  });

  it('a run stopped after half its batches keeps every old match (review I4)', async () => {
    // back to the two chunk judgements and one product per chunk
    await sql`delete from match_judgements`;
    await saveJudgements(sql, runId, [row('c', ['A-S', 'A-B', 'B-O', 'G-S'], [[0, 1, 2, 3]]), row('c', ['B-DB', 'G-DB'], [[0, 1]])]);
    await build();
    const before = await rows();
    const pairs = (r: Map<string, Row>) => LISTINGS.flatMap((x) => LISTINGS.filter((y) => x.key < y.key && r.get(x.key)!.canonical_id === r.get(y.key)!.canonical_id).map((y) => `${x.key}+${y.key}`));
    // the run re-splits them into two new groups and stops after the first batch was saved
    await saveJudgements(sql, runId, [row('c', ['A-S', 'A-B', 'B-O'], [[0, 1, 2]])]);
    expect(await supersedeJudgements(sql, { complete: false })).toBe(0);
    await build();
    expect(pairs(await rows())).toEqual(pairs(before));
  });
});
