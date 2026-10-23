// Migration 007, the candidate query and the writes, on a throwaway PGlite server (only when SITE_BUILD_TEST_DB is set).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brandStatus, loadBrandContext } from '../../src/names/brand.js';
import { changedGroups, loadGroups, titleHash } from '../../src/names/select.js';
import { finishRun, hasCanonicalColumns, loadStoredOk, markRejected, saveCanonical, saveResults, startRun } from '../../src/names/store.js';

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

    const product = async (shopId: number, externalId: string, parent: string | null, title: string, variant: string | null, path = 'Computers > Laptops') =>
      (await sql<{ id: string }[]>`
        insert into products (shop_id, external_id, parent_external_id, title, variant_title, category_path)
        values (${shopId}, ${externalId}, ${parent}, ${title}, ${variant}, ${path}) returning id`)[0].id;
    const p1 = await product(shopA, 'P1-8', 'P1', 'Lenovo IdeaPad Slim 5', '8GB');
    await product(shopA, 'P1-16', 'P1', 'Lenovo IdeaPad Slim 5', '16GB');
    const k = await product(shopA, 'K1', null, 'Kettle 1.7L', null, 'Kitchen > Kettles');
    const s1 = await product(shopA, 'S1', null, 'Kalkara Champagne Sunglasses', null, 'Type_Sunglasses');
    const h = await product(hidden, 'H1', null, 'Hidden', null);

    const sp = async (shopId: number, key: string, title: string, category: string, rep: string, ageDays = 0) =>
      sql`insert into site_products (shop_id, group_key, title, brand, category, rep_product_id, verdict, updated_at)
          values (${shopId}, ${key}, ${title}, 'Lenovo', ${category}, ${rep}, 'none', now() - ${`${ageDays} days`}::interval)`;
    await sp(shopA, 'P1', 'Lenovo IdeaPad Slim 5', 'laptops', p1);
    await sp(shopA, 'K1', 'Kettle 1.7L', 'appliances', k);
    // stored under drinks by the old rules; today's rules file it under fashion
    await sp(shopA, 'S1', 'Kalkara Champagne Sunglasses', 'drinks', s1);
    await sp(shopA, 'OLD', 'Old', 'appliances', k, 5);
    await sp(hidden, 'H1', 'Hidden', 'other', h);
  });

  afterAll(() => stop());

  it('loads fresh groups of visible shops with their variant titles and category path', async () => {
    const groups = await loadGroups(sql, {});
    expect(groups.map((g) => g.groupKey).sort()).toEqual(['K1', 'P1', 'S1']);
    const p1 = groups.find((g) => g.groupKey === 'P1')!;
    expect(p1.variantTitles.sort()).toEqual(['16GB', '8GB']);
    expect(p1.categoryPath).toBe('Computers > Laptops');
    expect(p1.shopSlug).toBe('a');
    expect(p1.storedHash).toBeNull();
    expect((await loadGroups(sql, { categories: ['laptops'] })).map((g) => g.groupKey)).toEqual(['P1']);
  });

  it('recomputes the category with the current rules and keeps the stored one', async () => {
    const s1 = (await loadGroups(sql, {})).find((g) => g.groupKey === 'S1')!;
    expect(s1.category).toBe('fashion');
    expect(s1.storedCategory).toBe('drinks');
    expect((await loadGroups(sql, { categories: ['drinks'] })).map((g) => g.groupKey)).toEqual([]);
    expect((await loadGroups(sql, { categories: ['fashion'] })).map((g) => g.groupKey)).toEqual(['S1']);
  });

  it('loads the brand context: shops and the distributor statistic, in one query', async () => {
    const ctx = await loadBrandContext(sql);
    expect(ctx.shops.map((s) => s.slug).sort()).toEqual(['a', 'hidden']);
    expect(ctx.distributors.size).toBe(0);
    expect(brandStatus('Lenovo', shopA, ctx).status).toBe('reliable');
    expect(brandStatus('Lenovo Malta Ltd', shopA, ctx).status).toBe('unreliable');
  });

  it('records a run, upserts product_names and then skips unchanged groups', async () => {
    const runId = await startRun(sql, { model: 'haiku', categories: ['laptops'], pilot: true, effort: 'low' });
    const groups = await loadGroups(sql, { categories: ['laptops'] });
    const g = groups[0];
    await saveResults(sql, runId, 'haiku', [
      { group: g, category: 'laptops', status: 'ok', displayName: 'Lenovo IdeaPad Slim 5', variantLabel: null, attrs: { ram_gb: [8, 16] }, reason: null, canonicalName: 'lenovo ideapadslim5' },
    ]);
    const stored = (await loadGroups(sql, { categories: ['laptops'] }))[0];
    expect(stored.storedCanonicalStatus).toBe('ok');
    expect(stored.storedAttrs).toEqual({ ram_gb: [8, 16] });
    await finishRun(sql, runId, {
      batches: 1, items: 1, accepted: 1, rejected: 0, failedBatches: 0,
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, reportPath: 'out/names/x.html',
    });
    const [row] = await sql`select * from product_names`;
    expect(row.display_name).toBe('Lenovo IdeaPad Slim 5');
    expect(row.canonical_name).toBe('lenovo ideapadslim5');
    expect(row.canonical_status).toBe('ok');
    expect(row.attrs).toEqual({ ram_gb: [8, 16] });
    expect(row.title_hash).toBe(titleHash('Lenovo IdeaPad Slim 5', ['8GB', '16GB']));
    expect(Number(row.run_id)).toBe(runId); // bigint comes back as a string
    const [run] = await sql`select * from name_runs where id = ${runId}`;
    expect(run.accepted).toBe(1);
    expect(run.effort).toBe('low');
    expect(run.finished_at).not.toBeNull();
    expect(Number(run.reported_cost_usd)).toBeCloseTo(0.001);

    expect(changedGroups(await loadGroups(sql, { categories: ['laptops'] }))).toEqual([]);

    await saveResults(sql, runId, 'sonnet', [
      { group: g, category: 'laptops', status: 'rejected', displayName: null, variantLabel: null, attrs: {}, reason: 'lost tokens: 5' },
    ]);
    const rows = await sql`select status, reject_reason, model, display_name, canonical_name, canonical_status from product_names`;
    expect(rows).toEqual([{ status: 'rejected', reject_reason: 'lost tokens: 5', model: 'sonnet', display_name: null, canonical_name: null, canonical_status: null }]);
  });

  it('loads the stored status, re-queues rejected groups on request, and lets --recheck-stored retire ok names', async () => {
    const runId = await startRun(sql, { model: 'haiku', categories: ['laptops'], pilot: true });
    const g = (await loadGroups(sql, { categories: ['laptops'] }))[0];
    expect(g.storedStatus).toBe('rejected');
    expect(changedGroups([g])).toEqual([]);
    expect(changedGroups([g], { retryRejected: true }).map((x) => x.groupKey)).toEqual(['P1']);

    await saveResults(sql, runId, 'haiku', [
      { group: g, category: 'laptops', status: 'ok', displayName: 'Lenovo IdeaPad Slim 5', variantLabel: '8GB', attrs: { ram_gb: [8] }, reason: null },
    ]);
    expect(await loadStoredOk(sql)).toEqual([
      { shopId: shopA, groupKey: 'P1', category: 'laptops', displayName: 'Lenovo IdeaPad Slim 5', variantLabel: '8GB', attrs: { ram_gb: [8] } },
    ]);
    // --backfill-canonical writes only the canonical columns: the accepted display name stays
    await saveCanonical(sql, [{ shopId: shopA, groupKey: 'P1', canonicalName: null, reason: 'lost tokens: irl' }]);
    const [kept] = await sql`select display_name, variant_label, status, canonical_name, canonical_status, canonical_reason from product_names where group_key = 'P1'`;
    expect(kept).toEqual({ display_name: 'Lenovo IdeaPad Slim 5', variant_label: '8GB', status: 'ok', canonical_name: null, canonical_status: 'rejected', canonical_reason: 'lost tokens: irl' });
    await saveCanonical(sql, [{ shopId: shopA, groupKey: 'P1', canonicalName: 'lenovo ideapadslim5', reason: null }]);
    expect((await sql`select canonical_name, canonical_status from product_names where group_key = 'P1'`)[0]).toEqual({ canonical_name: 'lenovo ideapadslim5', canonical_status: 'ok' });
    expect(await hasCanonicalColumns(sql)).toBe(true);
    expect(await markRejected(sql, [{ shopId: shopA, groupKey: 'P1', reason: 'lost tokens: 5' }])).toBe(1);
    const [row] = await sql`select status, reject_reason, display_name from product_names where group_key = 'P1'`;
    expect(row).toEqual({ status: 'rejected', reject_reason: 'recheck: lost tokens: 5', display_name: null });
    expect(await loadStoredOk(sql)).toEqual([]);
  });
});
