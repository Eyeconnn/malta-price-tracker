// Migration 013, the judge's reads (fresh listings of visible shops with variant titles and clean names) and its
// writes (judgements upserted by candidate key, older overlapping ones removed, runs), on a throwaway PGlite server.
// Runs only with SITE_BUILD_TEST_DB set, like test/site/build.test.ts.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadListings } from '../../src/match/load.js';
import {
  finishJudgeRun,
  hasJudgeTables,
  loadJudgements,
  loadStoredFingerprints,
  saveJudgements,
  startJudgeRun,
  type JudgementRow,
} from '../../src/match/store.js';

const PORT = 55471;
const HOUR = 3_600_000;

describe.skipIf(!process.env.SITE_BUILD_TEST_DB)('judge reads and writes on PGlite', () => {
  let stop: () => Promise<void> = async () => {};
  let sql: postgres.Sql;
  const shop: Record<string, number> = {};
  const migrations: string[] = [];

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
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      migrations.push(f);
      if (f >= '013') break;
      await sql.unsafe(await readFile(path.join(dir, f), 'utf8'));
    }
  }, 120_000);

  afterAll(async () => {
    await stop();
  }, 30_000);

  it('reports no tables and nothing stored before migration 013', async () => {
    expect(await hasJudgeTables(sql)).toBe(false);
    expect(await loadStoredFingerprints(sql)).toEqual(new Map());
    expect(await loadJudgements(sql)).toEqual([]);
  });

  it('applies migration 013 twice without error', async () => {
    const text = await readFile(path.resolve('db/migrations/013_match_judgements.sql'), 'utf8');
    expect(migrations.at(-1)).toBe('013_match_judgements.sql');
    await sql.unsafe(text);
    await sql.unsafe(text);
    expect(await hasJudgeTables(sql)).toBe(true);
  });

  it('loads fresh listings of visible shops with variant titles, the current clean name and the last match', async () => {
    const mk = async (slug: string, hidden = false) =>
      (shop[slug] = (await sql<{ id: number }[]>`
        insert into shops (slug, name, base_url, adapter, site_hidden) values (${slug}, ${slug}, ${'https://' + slug + '.test'}, 'woo', ${hidden}) returning id`)[0].id);
    await mk('a');
    await mk('b');
    await mk('hidden', true);
    const now = Date.now();
    const product = async (s: number, ext: string, parent: string | null, title: string, variant: string | null, seenHoursAgo = 1) =>
      (await sql<{ id: string }[]>`
        insert into products (shop_id, external_id, parent_external_id, title, variant_title, category_path, last_seen)
        values (${s}, ${ext}, ${parent}, ${title}, ${variant}, 'Phones > Apple', ${new Date(now - seenHoursAgo * HOUR)}) returning id`)[0].id;
    const rep = await product(shop.a, 'v1', 'P1', 'Apple iPhone 15', '128GB');
    await product(shop.a, 'v2', 'P1', 'Apple iPhone 15', '256GB');
    await product(shop.a, 'v3', 'P1', 'Apple iPhone 15', 'Old variant', 24 * 5);
    await product(shop.b, 'Q', null, 'iPhone 15 Apple', null);
    const site = async (s: number, key: string, title: string, more: { rep?: string; updated?: Date; price?: number; method?: string } = {}) =>
      sql`insert into site_products (shop_id, group_key, title, category, verdict, rep_product_id, price_cents, match_method, updated_at)
        values (${s}, ${key}, ${title}, 'phones', 'none', ${more.rep ?? null}, ${more.price ?? null}, ${more.method ?? null}, ${more.updated ?? new Date(now - HOUR)})`;
    await site(shop.a, 'P1', 'Apple iPhone 15', { rep, price: 79900, method: 'title' });
    await site(shop.b, 'Q', 'iPhone 15 Apple', { price: 78900 });
    await site(shop.b, 'OLD', 'Stale listing', { updated: new Date(now - 72 * HOUR) });
    await site(shop.hidden, 'H', 'Hidden shop listing');
    const [{ id: runId }] = await sql<{ id: string }[]>`insert into name_runs (model) values ('t') returning id`;
    await sql`insert into product_names (shop_id, group_key, source_title, title_hash, category, display_name, attrs, status, model, run_id)
      values (${shop.a}, 'P1', 'Apple iPhone 15', 'h', 'phones', 'Apple iPhone 15', ${sql.json({ storage_gb: [128, 256] })}, 'ok', 't', ${runId}),
             (${shop.b}, 'Q', 'an older title', 'h', 'phones', 'Old name', '{}'::jsonb, 'ok', 't', ${runId})`;

    const list = await loadListings(sql);
    expect(list.map((l) => l.groupKey)).toEqual(['P1', 'Q']);
    const [a, b] = list;
    expect(a).toMatchObject({
      shopId: shop.a, shopSlug: 'a', title: 'Apple iPhone 15', category: 'phones', categoryPath: 'Phones > Apple', priceCents: 79900,
      variantTitles: ['128GB', '256GB'], cleanName: 'Apple iPhone 15', attrs: { storage_gb: [128, 256] }, matchMethod: 'title',
    });
    expect(b).toMatchObject({ shopSlug: 'b', variantTitles: [], cleanName: null, priceCents: 78900 });
  });

  it('saves judgements by candidate key, replaces them, and removes older ones sharing a listing', async () => {
    const runId = await startJudgeRun(sql, { model: 'haiku', effort: 'low', pilot: true });
    const verdict = { clusters: [[0, 1]], apart: [], vetoed: [], final: [[0, 1]] };
    const row = (key: string, keys: string[], fp: string): JudgementRow => ({
      key, fingerprint: fp, model: 'haiku', effort: 'low', verdict,
      members: keys.map((k, i) => ({ shop_id: i === 0 ? shop.a : shop.b, group_key: k, site_product_id: i + 1 })),
    });
    expect(await saveJudgements(sql, runId, [row('c1', ['P1', 'Q'], 'f1'), row('c2', ['X', 'Y'], 'f2')])).toEqual({ saved: 2, superseded: 0 });
    expect(await saveJudgements(sql, runId, [row('c1', ['P1', 'Q'], 'f1b')])).toEqual({ saved: 1, superseded: 0 });
    expect(await loadStoredFingerprints(sql)).toEqual(new Map([['c1', 'f1b'], ['c2', 'f2']]));
    // a new candidate group holding listing Q replaces the one Q was in
    expect(await saveJudgements(sql, runId, [row('c3', ['Z', 'Q'], 'f3')])).toEqual({ saved: 1, superseded: 1 });
    const stored = await loadJudgements(sql);
    expect(stored.map((j) => j.key).sort()).toEqual(['c2', 'c3']);
    expect(stored.find((j) => j.key === 'c3')).toMatchObject({ verdict, model: 'haiku', effort: 'low', members: [{ shop_id: shop.a, group_key: 'Z', site_product_id: 1 }, { shop_id: shop.b, group_key: 'Q', site_product_id: 2 }] });

    await finishJudgeRun(sql, runId, {
      batches: 1, groups: 3, judged: 3, rejected: 0, matched: 2, vetoes: 1, failedBatches: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 1,
      cacheWriteTokens: 2, thinkingTokens: 0, costUsd: 0.0123, reportPath: 'out/judge/x.html',
    });
    const [r] = await sql`select finished_at, groups, matched, vetoes, reported_cost_usd::float as cost, report_path from judge_runs where id = ${runId}`;
    expect(r).toMatchObject({ groups: 3, matched: 2, vetoes: 1, cost: 0.0123, report_path: 'out/judge/x.html' });
    expect(r.finished_at).not.toBeNull();
  });
});
