// saveBatch writes was_source and feed_was_price_cents (migration 015), on PGlite with the real migrations.
// Runs only with SITE_BUILD_TEST_DB set, like test/site/build.test.ts. src/db.ts is mocked, so no real database is used.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Shop } from '../src/types.js';
import { blankRecord } from '../src/util/normalise.js';

const PORT = 55471;
let sql: postgres.Sql;
vi.mock('../src/db.js', () => ({ db: () => sql, closeDb: async () => {} }));

describe.skipIf(!process.env.SITE_BUILD_TEST_DB)('saveBatch with shown was prices on PGlite', () => {
  let stop: () => Promise<void> = async () => {};

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
    for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) await sql.unsafe(await readFile(path.join(dir, f), 'utf8'));
  }, 120_000);

  afterAll(async () => {
    await stop();
  }, 30_000);

  it('stores the shown was price, its source and the feed regular price, and marks Black Friday from the price name', async () => {
    const { saveBatch, startRun } = await import('../src/pipeline/store.js');
    const [{ id }] = await sql<{ id: number }[]>`
      insert into shops (slug, name, base_url, adapter) values ('atoz', 'AtoZ', 'https://atoz.test', 'woo') returning id`;
    const shop: Shop = { id, slug: 'atoz', name: 'AtoZ', base_url: 'https://atoz.test', category: null, adapter: 'woo', config: {}, tier: 'P1', active: true };
    const shown = { ...blankRecord('261895'), title: 'LENOVO V15 G5 IRL', price_cents: 79900, was_price_cents: 96900, was_source: 'shown' as const, feed_was_price_cents: 80900, badge_text: 'Black Friday' };
    const plain = { ...blankRecord('1'), title: 'Other', price_cents: 1000, was_price_cents: 1200 };
    const runId = await startRun(id, 'full');
    await saveBatch(shop, runId, [shown, plain], new Date('2026-10-24T01:00:00Z'));

    const rows = await sql`
      select p.external_id, p.bf_status, p.bf_marker, o.was_price_cents, o.was_source, o.feed_was_price_cents, o.badge_text, o.bf_marked
      from price_observations o join products p on p.id = o.product_id order by p.external_id`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { external_id: '1', bf_status: null, bf_marker: null, was_price_cents: 1200, was_source: null, feed_was_price_cents: null, badge_text: null, bf_marked: false },
      {
        external_id: '261895',
        bf_status: 'marked',
        bf_marker: 'badge: Black Friday',
        was_price_cents: 96900,
        was_source: 'shown',
        feed_was_price_cents: 80900,
        badge_text: 'Black Friday',
        bf_marked: true,
      },
    ]);
  }, 60_000);
});
