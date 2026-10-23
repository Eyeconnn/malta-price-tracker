// The photo downloader (src/pipeline/images.ts) against PGlite with the real migrations, a fake fetch and a fake R2.
// Runs only with SITE_BUILD_TEST_DB set, like build.test.ts.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shop } from '../../src/types.js';

// the real fetchers (robots.txt, delays, failure budget) against fake hosts: only the network is stubbed
const net = vi.hoisted(() => ({ route: (_url: string): Response => new Response('', { status: 404 }), log: [] as string[] }));
vi.mock('../../src/http/safeNet.js', () => ({
  safeFetch: vi.fn(async (url: string) => {
    net.log.push(url);
    return net.route(url);
  }),
}));
const { downloadImagesForShop, photoCandidates, photoStorage, PHOTO_STORAGE_CAP_BYTES } = await import('../../src/pipeline/images.js');
const { ShopAbortError, ShopFetcher } = await import('../../src/http/fetcher.js');

const PORT = 55481;
const HOUR = 3_600_000;
const u = (n: string) => `https://alpha.test/img/${n}`;

describe.skipIf(!process.env.SITE_BUILD_TEST_DB)('photo downloader on PGlite', () => {
  let stop: () => Promise<void> = async () => {};
  let sql: postgres.Sql;
  let png: Buffer;
  let gif: Buffer;
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
    gif = await readFile(path.resolve('test/fixtures/images/two-frames.gif'));
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
    await sql`delete from snapshots`;
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
    // G2: seen an hour ago, an animated GIF; G6 shares its picture; G3 is not an image
    await p(20, 'G2', null, u('2.gif'), 1);
    await p(60, 'G6', null, u('2.gif'), 1.5);
    await p(30, 'G3', null, u('3.html'), 3);
    // G4 has a stored copy already; G5 was last seen 10 days ago
    await p(40, 'G4', null, u('4.png'), 1);
    await sql`insert into images (source_url, r2_key, sha256, content_type, bytes) values (${u('4.png')}, ${'img/' + 'c'.repeat(64) + '.webp'}, ${'d'.repeat(64)}, 'image/webp', 100)`;
    await p(50, 'G5', null, u('5.png'), 240);
  });

  const fakes = () => {
    const bodies: Record<string, Buffer | number> = { [u('1a.png')]: png, [u('1b.png')]: 404, [u('2.gif')]: gif, [u('3.html')]: Buffer.from('<html>no</html>') };
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
    // G6 shares the GIF of G2: fetched once
    expect(fetchImage.mock.calls.map((c) => c[0])).toEqual([u('1b.png'), u('1a.png'), u('2.gif'), u('3.html')]);
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
    expect(by[u('2.gif')]).toMatchObject({ width: 40, height: 40, content_type: 'image/webp' });
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

  it('counts each stored copy once for the storage summary', async () => {
    const { fetchImage, put } = fakes();
    await downloadImagesForShop(shop, { sql, fetchImage, put });
    await sql`insert into images (source_url, r2_key, sha256, bytes) select ${u('dup.png')}, r2_key, sha256, bytes from images where source_url = ${u('1a.png')}`;
    await sql`insert into images (source_url, r2_key, sha256, bytes) values (${u('old.jpg')}, ${'images/' + 'f'.repeat(64) + '.jpg'}, ${'f'.repeat(64)}, 999999)`;
    const [{ total }] = await sql<{ total: number }[]>`select (sum(distinct bytes))::int as total from images where r2_key like 'img/%'`;
    await sql`insert into snapshots (shop_id, url, r2_key, bytes) values (1, 'https://alpha.test/', 'snapshots/a.html.gz', 5000), (1, 'https://alpha.test/x', null, 7000)`;
    expect(await photoStorage(sql)).toEqual({ count: 3, bytes: total, snapshotBytes: 5000 });
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

  it('stops before the R2 storage cap (photos + snapshots + an allowance)', async () => {
    const { fetchImage, put } = fakes();
    expect(PHOTO_STORAGE_CAP_BYTES).toBe(9e9);
    // snapshots alone already hold almost the whole cap
    await sql`insert into snapshots (shop_id, url, r2_key, bytes)
              select 1, 'https://alpha.test/' || g, 'snapshots/' || g, 1000000000 from generate_series(1, 9) g`;
    expect(await downloadImagesForShop(shop, { sql, fetchImage, put })).toMatchObject({ downloaded: 0 });
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('stops during the run when the stored copies reach the cap', async () => {
    const { fetchImage, put } = fakes();
    // with G4's 100-byte copy, 100 bytes below the cap less its allowance: the first stored copy reaches it
    await sql`insert into snapshots (shop_id, url, r2_key, bytes) select 1, 'https://alpha.test/' || g, 'snapshots/' || g, 889999980 from generate_series(1, 10) g`;
    await downloadImagesForShop(shop, { sql, fetchImage, put });
    expect(put).toHaveBeenCalledTimes(1);
  });

  describe('a fetcher that gives up (hotlink 403s on a CDN)', () => {
    const cdn = (n: string) => `https://cdn.shopify.com/s/files/${n}.jpg`;
    beforeEach(async () => {
      net.log = [];
      net.route = (url) =>
        url.endsWith('/robots.txt') ? new Response('User-agent: *\nAllow: /\n')
        : url.startsWith('https://cdn.shopify.com/') ? new Response('hotlinking not allowed', { status: 403 })
        : new Response(new Uint8Array(png));
      await sql`delete from products`;
      await sql`delete from site_products`;
      await sql`insert into shops (id, slug, name, base_url, adapter) values (2, 'beta', 'Beta', 'https://beta.test', 'woo')`;
      const ago = (h: number) => new Date(Date.now() - h * HOUR);
      for (let i = 1; i <= 7; i++) {
        await sql`insert into products (id, shop_id, external_id, title, image_url, last_seen) values (${100 + i}, 1, ${'C' + i}, 'c', ${cdn('a' + i)}, ${ago(i / 10)})`;
      }
      // a photo on the shop's own host, seen after the CDN ones
      await sql`insert into products (id, shop_id, external_id, title, image_url, last_seen) values (120, 1, 'OWN', 'own', ${u('own.png')}, ${ago(5)})`;
      await sql`insert into products (id, shop_id, external_id, title, image_url, last_seen) values (200, 2, 'B1', 'b', ${cdn('b1')}, ${ago(1)})`;
    });

    it('records the real 403s, then stops that CDN for the run: no failure marks, no budget spent', async () => {
      const put = vi.fn(async () => {});
      const shopFetcher = new ShopFetcher({ userAgent: 'TestBot/1.0', allowedHosts: ['alpha.test'], minDelayMs: 0, maxDelayMs: 0 });
      // 5 HTTP 403s, the 6th consecutive failure makes the fetcher give up; budget 6 still reaches the own-host photo
      await downloadImagesForShop({ ...shop, config: { images_per_run: 6 } } as Shop, { sql, put, shopFetcher });
      const rows = await sql<{ source_url: string; error: string | null; r2_key: string | null }[]>`select source_url, error, r2_key from images order by source_url`;
      const errors = rows.filter((r) => r.error !== null);
      expect(errors).toHaveLength(5);
      expect(errors.every((r) => r.error!.includes('403'))).toBe(true);
      expect(rows.map((r) => r.source_url)).not.toContain(cdn('a6'));
      expect(rows.map((r) => r.source_url)).not.toContain(cdn('a7'));
      expect(rows.find((r) => r.source_url === u('own.png'))?.r2_key).toMatch(/^img\//);
      // a7 was never requested once the CDN fetcher had given up
      expect(net.log.filter((l) => l === cdn('a7'))).toHaveLength(0);

      // another shop on the same CDN in the same process: skipped, not marked failed
      await downloadImagesForShop({ id: 2, slug: 'beta', name: 'Beta', base_url: 'https://beta.test', config: {} } as unknown as Shop, { sql, put });
      const [b] = await sql`select * from images where source_url = ${cdn('b1')}`;
      expect(b).toBeUndefined();
    }, 30_000);

    it('a fetcher that has given up (the run fetcher after a failed scrape) writes no failure rows', async () => {
      const put = vi.fn(async () => {});
      const shopFetcher = { get: vi.fn(async () => { throw new ShopAbortError('giving up on shop'); }) } as unknown as InstanceType<typeof ShopFetcher>;
      await sql`delete from products where shop_id = 1 and id <> 120`;
      await downloadImagesForShop(shop, { sql, put, shopFetcher });
      expect(shopFetcher.get).toHaveBeenCalledTimes(1);
      expect(await sql`select * from images where source_url = ${u('own.png')}`).toHaveLength(0);
    });
  });
});
