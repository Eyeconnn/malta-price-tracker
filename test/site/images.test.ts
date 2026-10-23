// The photo downloader (src/pipeline/images.ts) against PGlite with the real migrations, a fake fetch and a fake R2.
// Runs only with SITE_BUILD_TEST_DB set, like build.test.ts.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadImagesForShop, photoCandidates } from '../../src/pipeline/images.js';
import type { Shop } from '../../src/types.js';

const PORT = 55481;
const HOUR = 3_600_000;
const u = (n: string) => `https://alpha.test/img/${n}`;

describe.skipIf(!process.env.SITE_BUILD_TEST_DB)('photo downloader on PGlite', () => {
  let stop: () => Promise<void> = async () => {};
  let sql: postgres.Sql;
  let png: Buffer;
  let svg: Buffer;
  const shop = { id: 1, slug: 'alpha', name: 'Alpha', base_url: 'https://alpha.test', config: {} } as unknown as Shop;

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
    png = await readFile(path.resolve('test/fixtures/images/photo-800x600.png'));
    svg = await readFile(path.resolve('test/fixtures/images/logo.svg'));
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await stop();
  }, 30_000);

  beforeEach(async () => {
    vi.stubEnv('IMAGES_ENABLED', 'on');
    await sql`delete from site_products`;
    await sql`delete from products`;
    await sql`delete from images`;
    await sql`delete from shops`;
    await sql`insert into shops (id, slug, name, base_url, adapter) values (1, 'alpha', 'Alpha', 'https://alpha.test', 'woo')`;
    const ago = (h: number) => new Date(Date.now() - h * HOUR);
    const p = (id: number, ext: string, parent: string | null, url: string | null, seenH: number, bf: string | null = null) =>
      sql`insert into products (id, shop_id, external_id, parent_external_id, title, image_url, last_seen, bf_status)
          values (${id}, 1, ${ext}, ${parent}, ${'t' + id}, ${url}, ${ago(seenH)}, ${bf})`;
    // G1: marked Black Friday; its site row shows the 1b picture, which fails, so the 1a picture is used
    await p(10, 'G1-a', 'G1', u('1a.png'), 2);
    await p(11, 'G1-b', 'G1', u('1b.png'), 2, 'marked');
    await sql`insert into site_products (shop_id, group_key, title, image_url, verdict) values (1, 'G1', 'G1', ${u('1b.png')}, 'none')`;
    // G2: seen an hour ago, an SVG; G6 shares its picture; G3 is not an image
    await p(20, 'G2', null, u('2.svg'), 1);
    await p(60, 'G6', null, u('2.svg'), 1.5);
    await p(30, 'G3', null, u('3.html'), 3);
    // G4 has a stored copy already; G5 was last seen 10 days ago
    await p(40, 'G4', null, u('4.png'), 1);
    await sql`insert into images (source_url, r2_key, sha256, content_type, bytes) values (${u('4.png')}, ${'img/' + 'c'.repeat(64) + '.webp'}, ${'d'.repeat(64)}, 'image/webp', 100)`;
    await p(50, 'G5', null, u('5.png'), 240);
  });

  const fakes = () => {
    const bodies: Record<string, Buffer | number> = { [u('1a.png')]: png, [u('1b.png')]: 404, [u('2.svg')]: svg, [u('3.html')]: Buffer.from('<html>no</html>') };
    const fetchImage = vi.fn(async (url: string) => {
      const b = bodies[url];
      return typeof b === 'number' ? { status: b, body: Buffer.alloc(0) } : { status: 200, body: b! };
    });
    const put = vi.fn(async (_key: string, _body: Buffer, _type: string) => {});
    return { fetchImage, put };
  };

  it('lists groups without a photo: Black Friday first, then most recently seen; the site row picture first', async () => {
    const c = await photoCandidates(sql, 1, 300);
    expect(c.map((g) => g.group_key)).toEqual(['G1', 'G2', 'G6', 'G3']);
    expect(c[0].urls).toEqual([u('1b.png'), u('1a.png')]);
  });

  it('stores one small WebP copy per group, falls back to another variant only when the first fails', async () => {
    const { fetchImage, put } = fakes();
    const res = await downloadImagesForShop(shop, { sql, fetchImage, put });
    expect(res.downloaded).toBe(2);
    // G6 shares the SVG of G2: fetched once
    expect(fetchImage.mock.calls.map((c) => c[0])).toEqual([u('1b.png'), u('1a.png'), u('2.svg'), u('3.html')]);
    expect(put).toHaveBeenCalledTimes(2);
    for (const [key, body, type] of put.mock.calls) {
      expect(key).toMatch(/^img\/[0-9a-f]{64}\.webp$/);
      expect(type).toBe('image/webp');
      const meta = await sharp(body).metadata();
      expect(meta.format).toBe('webp');
      expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(480);
    }
    const rows = await sql<{ source_url: string; r2_key: string | null; error: string | null; width: number | null; height: number | null; bytes: number | null; content_type: string | null }[]>`
      select source_url, r2_key, error, width, height, bytes, content_type from images order by source_url`;
    const by = Object.fromEntries(rows.map((r) => [r.source_url, r]));
    expect(by[u('1b.png')]).toMatchObject({ r2_key: null, error: 'HTTP 404' });
    expect(by[u('1a.png')]).toMatchObject({ width: 480, height: 360, content_type: 'image/webp', error: null });
    expect(by[u('1a.png')].bytes).toBe((put.mock.calls[0][1] as Buffer).length);
    expect(by[u('2.svg')]).toMatchObject({ width: 480, height: 240, content_type: 'image/webp' });
    expect(by[u('3.html')]).toMatchObject({ r2_key: null, error: 'not an image' });
    const linked = await sql<{ id: string; key: string | null }[]>`
      select p.id, i.r2_key as key from products p left join images i on i.id = p.image_id order by p.id`;
    const keyOf = Object.fromEntries(linked.map((r) => [Number(r.id), r.key]));
    expect(keyOf[10]).toBe(put.mock.calls[0][0]);
    expect(keyOf[20]).toBe(put.mock.calls[1][0]);
    expect(keyOf[60]).toBe(put.mock.calls[1][0]);
    expect(keyOf[40]).toBe('img/' + 'c'.repeat(64) + '.webp');
    expect(keyOf[11]).toBeNull();
    expect(keyOf[50]).toBeNull();
  });

  it('keeps to the per-run request budget', async () => {
    const { fetchImage, put } = fakes();
    await downloadImagesForShop({ ...shop, config: { images_per_run: 1 } } as Shop, { sql, fetchImage, put });
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('stores the same original once', async () => {
    const { fetchImage, put } = fakes();
    await sql`update products set image_url = ${u('1a-copy.png')} where id = 20`;
    fetchImage.mockImplementation(async (url: string) => (url === u('1b.png') ? { status: 404, body: Buffer.alloc(0) } : { status: 200, body: png }));
    await downloadImagesForShop(shop, { sql, fetchImage, put });
    expect(put).toHaveBeenCalledTimes(1);
    const [{ keys }] = await sql<{ keys: number }[]>`select count(distinct r2_key)::int as keys from images where r2_key like 'img/%' and sha256 <> ${'d'.repeat(64)}`;
    expect(keys).toBe(1);
  });

  it('stops on an R2 failure without marking the URL as failed', async () => {
    const { fetchImage, put } = fakes();
    put.mockRejectedValue(new Error('Access Denied'));
    await downloadImagesForShop(shop, { sql, fetchImage, put });
    expect(fetchImage.mock.calls.map((c) => c[0])).toEqual([u('1b.png'), u('1a.png')]);
    const [row] = await sql`select * from images where source_url = ${u('1a.png')}`;
    expect(row).toBeUndefined();
  });

  it('does nothing while IMAGES_ENABLED is off', async () => {
    vi.stubEnv('IMAGES_ENABLED', '');
    const { fetchImage, put } = fakes();
    expect(await downloadImagesForShop(shop, { sql, fetchImage, put })).toEqual({ downloaded: 0, linked: 0 });
    expect(fetchImage).not.toHaveBeenCalled();
  });
});
