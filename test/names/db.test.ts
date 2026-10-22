// Migration 007, the candidate query and the writes, on a throwaway PGlite server (only when SITE_BUILD_TEST_DB is set).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changedGroups, loadGroups, titleHash } from '../../src/names/select.js';
import { finishRun, saveResults, startRun } from '../../src/names/store.js';

const PORT = 55461;

describe.skipIf(!process.env.SITE_BUILD_TEST_DB)('name normaliser on PGlite', () => {
  let stop: () => Promise<void> = async () => {};
  let sql: postgres.Sql;
  let shopA = 0;

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

    const shop = async (slug: string, hidden = false, active = true) =>
      (await sql<{ id: number }[]>`
        insert into shops (slug, name, base_url, adapter, site_hidden, active)
        values (${slug}, ${slug}, ${'https://' + slug + '.test'}, 'woo', ${hidden}, ${active}) returning id`)[0].id;
    shopA = await shop('a');
    const hidden = await shop('hidden', true);

    const product = async (shopId: number, externalId: string, parent: string | null, title: string, variant: string | null) =>
      (await sql<{ id: string }[]>`
        insert into products (shop_id, external_id, parent_external_id, title, variant_title, category_path)
        values (${shopId}, ${externalId}, ${parent}, ${title}, ${variant}, 'Computers > Laptops') returning id`)[0].id;
    const p1 = await product(shopA, 'P1-8', 'P1', 'Lenovo IdeaPad Slim 5', '8GB');
    await product(shopA, 'P1-16', 'P1', 'Lenovo IdeaPad Slim 5', '16GB');
    const k = await product(shopA, 'K1', null, 'Kettle 1.7L', null);
    const h = await product(hidden, 'H1', null, 'Hidden', null);

    const sp = async (shopId: number, key: string, title: string, category: string, rep: string, ageDays = 0) =>
      sql`insert into site_products (shop_id, group_key, title, brand, category, rep_product_id, verdict, updated_at)
          values (${shopId}, ${key}, ${title}, 'Lenovo', ${category}, ${rep}, 'none', now() - ${`${ageDays} days`}::interval)`;
    await sp(shopA, 'P1', 'Lenovo IdeaPad Slim 5', 'laptops', p1);
    await sp(shopA, 'K1', 'Kettle 1.7L', 'appliances', k);
    await sp(shopA, 'OLD', 'Old', 'appliances', k, 5);
    await sp(hidden, 'H1', 'Hidden', 'other', h);
  });

  afterAll(() => stop());

  it('loads fresh groups of visible shops with their variant titles and category path', async () => {
    const groups = await loadGroups(sql, {});
    expect(groups.map((g) => g.groupKey).sort()).toEqual(['K1', 'P1']);
    const p1 = groups.find((g) => g.groupKey === 'P1')!;
    expect(p1.variantTitles.sort()).toEqual(['16GB', '8GB']);
    expect(p1.categoryPath).toBe('Computers > Laptops');
    expect(p1.shopSlug).toBe('a');
    expect(p1.storedHash).toBeNull();
    expect((await loadGroups(sql, { categories: ['laptops'] })).map((g) => g.groupKey)).toEqual(['P1']);
  });

  it('records a run, upserts product_names and then skips unchanged groups', async () => {
    const runId = await startRun(sql, { model: 'haiku', categories: ['laptops'], pilot: true });
    const groups = await loadGroups(sql, { categories: ['laptops'] });
    const g = groups[0];
    await saveResults(sql, runId, 'haiku', [
      { group: g, category: 'laptops', status: 'ok', displayName: 'Lenovo IdeaPad Slim 5', variantLabel: null, attrs: { ram_gb: [8, 16] }, reason: null },
    ]);
    await finishRun(sql, runId, {
      batches: 1, items: 1, accepted: 1, rejected: 0, failedBatches: 0,
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, reportPath: 'out/names/x.html',
    });
    const [row] = await sql`select * from product_names`;
    expect(row.display_name).toBe('Lenovo IdeaPad Slim 5');
    expect(row.attrs).toEqual({ ram_gb: [8, 16] });
    expect(row.title_hash).toBe(titleHash('Lenovo IdeaPad Slim 5', ['8GB', '16GB']));
    expect(Number(row.run_id)).toBe(runId); // bigint comes back as a string
    const [run] = await sql`select * from name_runs where id = ${runId}`;
    expect(run.accepted).toBe(1);
    expect(run.finished_at).not.toBeNull();
    expect(Number(run.reported_cost_usd)).toBeCloseTo(0.001);

    expect(changedGroups(await loadGroups(sql, { categories: ['laptops'] }))).toEqual([]);

    await saveResults(sql, runId, 'sonnet', [
      { group: g, category: 'laptops', status: 'rejected', displayName: null, variantLabel: null, attrs: {}, reason: 'lost tokens: 5' },
    ]);
    const rows = await sql`select status, reject_reason, model, display_name from product_names`;
    expect(rows).toEqual([{ status: 'rejected', reject_reason: 'lost tokens: 5', model: 'sonnet', display_name: null }]);
  });
});
