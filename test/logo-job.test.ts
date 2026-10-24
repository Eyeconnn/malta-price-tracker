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

beforeAll(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  pg = await PGlite.create({ dataDir: 'memory://', extensions: { pg_trgm } });
  const dir = path.resolve('db/migrations');
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(await readFile(path.join(dir, f), 'utf8'));
  pngLogo = await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
  banner = await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#06c' } }).jpeg().toBuffer();
  await pg.exec(`
    insert into shops (slug, name, base_url, adapter, active, logo_key, logo_checked_at, logo_error) values
      ('gadget', 'Gadget Corner', 'https://www.gadget.example.mt', 'woo', true, null, null, null),
      ('toybox', 'Toy Box', 'https://toybox.example.mt', 'woo', true, null, null, null),
      ('closed', 'Closed', 'https://closed.example.mt', 'woo', true, null, null, null),
      ('banner', 'Banner', 'https://banner.example.mt', 'woo', true, null, null, null),
      ('hasone', 'Has One', 'https://hasone.example.mt', 'woo', true, 'img/${'c'.repeat(64)}.webp', now() - interval '90 days', null),
      ('recent', 'Recent', 'https://recent.example.mt', 'woo', true, null, now() - interval '5 days', 'HTTP 404'),
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
    'https://stale.example.mt/icon-192.png': { body: pngLogo },
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
    expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(['webp', 128, 43, true]);
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

  it('--retry looks again at checked shops without a logo, never at shops with one', async () => {
    const out = await fetchLogos({ retry: true }, deps());
    expect(out.map((r) => r.slug)).toEqual(['banner', 'closed', 'recent']);
    // a bot check page means no logo
    expect((await shopRow('recent')).logo_error).toMatch(/bot check/);
    expect(requests.filter((u) => u.includes('recent'))).toEqual(['https://recent.example.mt']);
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
    expect(logs[0]).toMatch(/closed was checked recently .*--retry/);
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
});
