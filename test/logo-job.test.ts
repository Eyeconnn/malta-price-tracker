// The logo job (src/pipeline/logos.ts fetchLogos) on PGlite with every migration: which shops it looks at, what it
// records, --shop, --retry and --dry-run. Requests go to recorded answers (no network).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FetchResult, HttpError } from '../src/http/fetcher.js';
import { type LogoDb, type LogoGet, type LogoJobDeps, type LogoShop, fetchLogos } from '../src/pipeline/logos.js';

let pg: PGlite;
const db: LogoDb = { query: async (text, params = []) => (await pg.query<Record<string, unknown>>(text, params)).rows as never };
const fixture = (name: string) => readFile(path.resolve('test/fixtures/logos', name), 'utf8');

type Answer = { status?: number; body: Buffer | string } | Error;
let routes: Record<string, Answer> = {};
let requests: string[] = [];
let puts: { key: string; body: Buffer; contentType: string }[] = [];
let logs: string[] = [];

function answer(url: string): FetchResult {
  requests.push(url);
  const a = routes[url];
  if (a instanceof Error) throw a;
  if (!a) return result(url, 404, Buffer.from('not found'));
  const status = a.status ?? 200;
  // as ShopFetcher: statuses other than 200/203/204/206/404/410 throw
  if (![200, 203, 204, 206, 404, 410].includes(status)) throw new HttpError(url, status);
  return result(url, status, typeof a.body === 'string' ? Buffer.from(a.body) : a.body);
}
function result(url: string, status: number, body: Buffer): FetchResult {
  return { url, status, headers: new Headers(), body, text: () => body.toString('utf8'), json: () => JSON.parse(body.toString('utf8')) };
}
const getFor = (_shop: LogoShop): LogoGet => async (url) => answer(url);

const deps = (over: Partial<LogoJobDeps> = {}): LogoJobDeps => ({
  db,
  getFor,
  put: async (key, body, contentType) => {
    puts.push({ key, body, contentType });
  },
  log: (m) => logs.push(m),
  ...over,
});

const shopRow = async (slug: string) =>
  (await pg.query<{ logo_key: string | null; logo_checked_at: Date | null; logo_error: string | null }>('select logo_key, logo_checked_at, logo_error from shops where slug = $1', [slug])).rows[0]!;

let pngLogo: Buffer;
let banner: Buffer;
let squareLogo: Buffer;

beforeAll(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  pg = await PGlite.create({ dataDir: 'memory://', extensions: { pg_trgm } });
  const dir = path.resolve('db/migrations');
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(await readFile(path.join(dir, f), 'utf8'));
  pngLogo = await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
  squareLogo = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 90, b: 0, alpha: 1 } } }).png().toBuffer();
  banner = await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#06c' } }).jpeg().toBuffer();
  await pg.exec(`
    insert into shops (slug, name, base_url, adapter, active, logo_key, logo_checked_at, logo_error) values
      ('gadget', 'Gadget Corner', 'https://www.gadget.example.mt', 'woo', true, null, null, null),
      ('toybox', 'Toy Box', 'https://toybox.example.mt', 'woo', true, null, null, null),
      ('closed', 'Closed', 'https://closed.example.mt', 'woo', true, null, null, null),
      ('banner', 'Banner', 'https://banner.example.mt', 'woo', true, null, null, null),
      ('hasone', 'Has One', 'https://hasone.example.mt', 'woo', true, 'img/${'c'.repeat(64)}.webp', now() - interval '90 days', null),
      ('recent', 'Recent', 'https://recent.example.mt', 'woo', true, null, now() - interval '5 days', 'no usable logo (header https://recent.example.mt/logo.png: HTTP 404)'),
      ('capped', 'Capped', 'https://capped.example.mt', 'woo', true, null, now() - interval '2 days', 'home page: request cap of 4 reached'),
      ('missing', 'Missing', 'https://missing.example.mt', 'woo', true, null, now() - interval '2 days', 'no logo found on the home page'),
      ('stale', 'Stale', 'https://stale.example.mt', 'woo', true, null, now() - interval '40 days', 'HTTP 404'),
      ('sleeping', 'Sleeping', 'https://sleeping.example.mt', 'woo', false, null, null, null);
  `);
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  requests = [];
  puts = [];
  logs = [];
  routes = {
    'https://www.gadget.example.mt': { body: await fixture('header-img.html') },
    // the header logo is missing, so the JSON-LD logo is next
    'https://www.gadget.example.mt/media/org-logo.png': { body: pngLogo },
    'https://toybox.example.mt': { body: await fixture('jsonld.html') },
    'https://toybox.example.mt/wp-content/uploads/toybox.png': { body: pngLogo },
    'https://closed.example.mt': new HttpError('https://closed.example.mt', 403),
    'https://banner.example.mt': { body: '<html><head><meta property="og:image" content="/share.jpg"></head><body></body></html>' },
    'https://banner.example.mt/share.jpg': { body: banner },
    'https://stale.example.mt': { body: await fixture('icons.html') },
    'https://stale.example.mt/icon-192.png': { body: squareLogo },
    'https://recent.example.mt': { body: await fixture('challenge.html') },
    'https://sleeping.example.mt': { body: (await fixture('lazy-header.html')).replaceAll('lazy.example.mt', 'sleeping.example.mt') },
  };
});

describe('fetchLogos', () => {
  it('a dry run fetches and reports but stores and records nothing', async () => {
    const out = await fetchLogos({ dryRun: true, shop: 'toybox' }, deps());
    expect(out).toEqual([expect.objectContaining({ slug: 'toybox', status: 'found', source: 'json-ld' })]);
    expect(puts).toEqual([]);
    expect(await shopRow('toybox')).toEqual({ logo_key: null, logo_checked_at: null, logo_error: null });
  });

  it('looks at active shops without a logo that were never checked or failed over 30 days ago, and records the outcome', async () => {
    const out = await fetchLogos({}, deps());
    expect(out.map((r) => r.slug)).toEqual(['banner', 'closed', 'gadget', 'stale', 'toybox']);
    expect(requests.some((u) => u.includes('hasone') || u.includes('recent') || u.includes('sleeping'))).toBe(false);

    // found: our copy in R2 under img/<sha256>.webp, small and WebP
    expect(out.find((r) => r.slug === 'gadget')).toMatchObject({ status: 'found', source: 'json-ld', url: 'https://www.gadget.example.mt/media/org-logo.png' });
    const gadget = await shopRow('gadget');
    expect(gadget.logo_key).toMatch(/^img\/[0-9a-f]{64}\.webp$/);
    expect(gadget.logo_checked_at).not.toBeNull();
    expect(gadget.logo_error).toBeNull();
    const stored = puts.find((p) => p.key === gadget.logo_key)!;
    expect(stored.contentType).toBe('image/webp');
    const meta = await sharp(stored.body).metadata();
    expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(['webp', 192, 64, true]);
    expect(logs.join('\n')).toMatch(/\[gadget\] logo from the JSON-LD Organization logo https:\/\/www\.gadget\.example\.mt\/media\/org-logo\.png/);
    expect(logs.join('\n')).toMatch(/header .*gadget\.svg: HTTP 404/);
    expect((await shopRow('stale')).logo_key).toMatch(/^img\//);

    // a 403 means no logo: the error is recorded and nothing else is tried
    const closed = await shopRow('closed');
    expect(closed.logo_key).toBeNull();
    expect(closed.logo_checked_at).not.toBeNull();
    expect(closed.logo_error).toMatch(/home page: HTTP 403 \(refused; no logo, the initials stay\)/);
    expect(requests.filter((u) => u.includes('closed'))).toEqual(['https://closed.example.mt']);

    // an og:image that turns out to be a banner is not a logo
    expect((await shopRow('banner')).logo_error).toMatch(/og:image https:\/\/banner\.example\.mt\/share\.jpg: picture is 1200x630, not logo-like/);
  });

  it('a second run does nothing: shops with a logo are skipped and failures wait 30 days', async () => {
    const out = await fetchLogos({}, deps());
    expect(out).toEqual([]);
    expect(requests).toEqual([]);
    expect(logs).toEqual(['logos: nothing to do']);
  });

  it('--retry looks again at shops left with no usable logo or at the request cap, never after a 403 or a bot check', async () => {
    const out = await fetchLogos({ retry: true }, deps());
    // closed answered 403 and missing had no logo at all: not retried; hasone has a logo
    expect(out.map((r) => r.slug)).toEqual(['banner', 'capped', 'recent']);
    // a bot check page means no logo, and from now on --retry leaves it alone too
    expect((await shopRow('recent')).logo_error).toMatch(/bot check/);
    expect(requests.filter((u) => u.includes('recent'))).toEqual(['https://recent.example.mt']);
    requests = [];
    const again = await fetchLogos({ retry: true }, deps());
    // capped's home page answered 404 this time: no longer retried either
    expect(again.map((r) => r.slug)).toEqual(['banner']);
  });

  it('--shop looks at that shop only (inactive too) and says why when it is not looked at', async () => {
    const out = await fetchLogos({ shop: 'sleeping' }, deps());
    expect(out).toEqual([expect.objectContaining({ slug: 'sleeping', status: 'none' })]);
    expect(requests.every((u) => u.includes('sleeping'))).toBe(true);
    expect((await shopRow('sleeping')).logo_error).toMatch(/header https:\/\/sleeping\.example\.mt\/img\/brand\.png: HTTP 404/);

    logs = [];
    expect(await fetchLogos({ shop: 'hasone' }, deps())).toEqual([]);
    expect(logs[0]).toMatch(/hasone already has a logo/);
    logs = [];
    await fetchLogos({ shop: 'closed' }, deps());
    expect(logs[0]).toMatch(/closed was checked recently .*not retried \(home page: HTTP 403/);
  });

  it('reuses a stored product photo of the same picture instead of writing over it', async () => {
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(pngLogo).digest('hex');
    await pg.query(`insert into images (source_url, r2_key, sha256) values ('https://toybox.example.mt/p.png', $1, $2)`, [`img/${sha}.webp`, sha]);
    await pg.query(`update shops set logo_key = null, logo_checked_at = null where slug = 'toybox'`);
    await fetchLogos({ shop: 'toybox' }, deps());
    expect(puts).toEqual([]);
    expect((await shopRow('toybox')).logo_key).toBe(`img/${sha}.webp`);
  });

  it('an R2 failure stops the job and records nothing, so the shop is looked at next time', async () => {
    await pg.query(`delete from images`);
    await pg.query(`update shops set logo_key = null, logo_checked_at = null, logo_error = null where slug = 'toybox'`);
    const out = await fetchLogos({ shop: 'toybox' }, deps({ put: async () => Promise.reject(new Error('AccessDenied')) }));
    expect(out).toEqual([{ slug: 'toybox', status: 'skipped', reason: 'R2 upload failed' }]);
    expect(await shopRow('toybox')).toEqual({ logo_key: null, logo_checked_at: null, logo_error: null });
  });

  it('at the storage cap nothing is fetched', async () => {
    const out = await fetchLogos({ shop: 'toybox' }, deps({ storageFull: async () => true }));
    expect(out).toEqual([{ slug: 'toybox', status: 'skipped', reason: 'storage cap' }]);
    expect(requests).toEqual([]);
  });

  it('rate limiting, server errors and timeouts record nothing, so the next run looks again', async () => {
    await pg.exec(`insert into shops (slug, name, base_url, adapter, active) values
      ('busy', 'Busy', 'https://busy.example.mt', 'woo', true),
      ('slowpic', 'Slow Pic', 'https://slowpic.example.mt', 'woo', true),
      ('gone404', 'Gone', 'https://gone404.example.mt', 'woo', true)`);
    routes['https://busy.example.mt'] = new HttpError('https://busy.example.mt', 503);
    routes['https://slowpic.example.mt'] = { body: await fixture('icons.html') };
    routes['https://slowpic.example.mt/icon-192.png'] = new HttpError('https://slowpic.example.mt/icon-192.png', 429);
    routes['https://gone404.example.mt'] = new Error('timeout after 60000ms for https://gone404.example.mt');
    const out = (await fetchLogos({}, deps())).filter((r) => ['busy', 'slowpic', 'gone404'].includes(r.slug));
    expect(out).toEqual([
      { slug: 'busy', status: 'skipped', reason: 'home page: HTTP 503' },
      { slug: 'gone404', status: 'skipped', reason: expect.stringMatching(/timeout/) },
      { slug: 'slowpic', status: 'skipped', reason: expect.stringMatching(/icon-192\.png: HTTP 429/) },
    ]);
    // after the 429 nothing else is tried
    expect(requests.filter((u) => u.includes('slowpic'))).toEqual(['https://slowpic.example.mt', 'https://slowpic.example.mt/icon-192.png']);
    for (const slug of ['busy', 'slowpic', 'gone404']) expect(await shopRow(slug), slug).toEqual({ logo_key: null, logo_checked_at: null, logo_error: null });
    await pg.exec(`update shops set active = false where slug in ('busy', 'slowpic', 'gone404')`);
  });

  it('fetches a shop only under its lock, and not at all when another run holds it or has just done it', async () => {
    await pg.exec(`update shops set logo_key = null, logo_checked_at = null, logo_error = null where slug in ('toybox', 'gadget')`);
    const locked: number[] = [];
    let readyCalls = 0;
    const out = await fetchLogos(
      {},
      deps({
        ready: async () => {
          readyCalls++;
          return true;
        },
        withShopLock: async (id, fn) => {
          locked.push(id);
          const [row] = (await pg.query<{ slug: string }>('select slug from shops where id = $1', [id])).rows;
          // another run holds gadget; toybox was just done by another run
          if (row!.slug === 'gadget') return false;
          await pg.query(`update shops set logo_key = 'img/${'f'.repeat(64)}.webp' where id = $1`, [id]);
          await fn();
          return true;
        },
      }),
    );
    expect(out).toEqual([
      { slug: 'gadget', status: 'skipped', reason: 'locked by another run' },
      { slug: 'toybox', status: 'skipped', reason: 'done by another run' },
    ]);
    expect(locked).toHaveLength(2);
    expect(readyCalls).toBe(1);
    expect(requests).toEqual([]);
    expect((await shopRow('gadget')).logo_checked_at).toBeNull();
  });

  it('checks R2 only when a shop needs a look, and fetches nothing when it is not ready', async () => {
    let readyCalls = 0;
    const ready = async () => {
      readyCalls++;
      return false;
    };
    await pg.exec(`update shops set logo_checked_at = now(), logo_error = 'HTTP 404' where logo_key is null`);
    expect(await fetchLogos({}, deps({ ready }))).toEqual([]);
    expect(readyCalls).toBe(0);
    await pg.exec(`update shops set logo_key = null, logo_checked_at = null where slug = 'toybox'`);
    expect(await fetchLogos({}, deps({ ready }))).toEqual([]);
    expect(readyCalls).toBe(1);
    expect(requests).toEqual([]);
  });

  it('records nothing once the deadline has passed', async () => {
    await pg.exec(`update shops set logo_key = null, logo_checked_at = null, logo_error = null where slug = 'toybox'`);
    const ac = new AbortController();
    const out = await fetchLogos(
      { shop: 'toybox', signal: ac.signal },
      deps({
        getFor: () => async (url) => {
          const r = answer(url);
          ac.abort();
          return r;
        },
      }),
    );
    expect(out).toEqual([{ slug: 'toybox', status: 'skipped', reason: 'deadline' }]);
    expect(puts).toEqual([]);
    expect(await shopRow('toybox')).toEqual({ logo_key: null, logo_checked_at: null, logo_error: null });
  });

  it('prefers a wide header wordmark to the touch icon, and records the stored size', async () => {
    await pg.exec(`insert into shops (slug, name, base_url, adapter, active) values ('wordmark', 'Wordmark', 'https://wordmark.example.mt', 'woo', true)`);
    routes['https://wordmark.example.mt'] = {
      body: '<html><head><link rel="apple-touch-icon" href="/apple-touch-icon.png"></head><body><header><a href="/"><img class="logo" src="/wordmark.png" alt="Wordmark"></a></header></body></html>',
    };
    routes['https://wordmark.example.mt/wordmark.png'] = { body: await sharp({ create: { width: 600, height: 88, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer() };
    routes['https://wordmark.example.mt/apple-touch-icon.png'] = { body: squareLogo };
    const out = await fetchLogos({ shop: 'wordmark' }, deps());
    expect(out).toEqual([expect.objectContaining({ slug: 'wordmark', status: 'found', source: 'header', width: 256, height: 38 })]);
    expect(requests).toEqual(['https://wordmark.example.mt', 'https://wordmark.example.mt/wordmark.png']);
    expect((await pg.query('select logo_w, logo_h from shops where slug = $1', ['wordmark'])).rows[0]).toEqual({ logo_w: 256, logo_h: 38 });
  });
});

