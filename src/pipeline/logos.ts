// Shop logos (pnpm fetch-logos, migration 016). For each shop without a logo, the home page is read politely and the
// logo picked in this order: an <img> in the header, nav or home link that is named "logo" (class, id, alt, src or a
// wrapper's class or id); the JSON-LD Organization logo; an apple-touch-icon or icon link of at least 96 px; og:image
// only as a last resort and only when it looks like a logo (square-ish and small). Our small copy (WebP, at most
// 128 px, transparency kept) goes to R2 under img/<sha256 of the original>.webp, as product photos do, and the site
// serves only that copy: a visitor's browser never contacts a shop.
// Politeness: every request goes through ShopFetcher (robots.txt and Crawl-delay obeyed, SCRAPER_USER_AGENT, one
// request at a time, 2 to 5 s apart or the shop's longer gap, backoff on 429 and 5xx, private addresses refused),
// at most LOGO_MAX_REQUESTS per shop (robots.txt included). A 403, 401 or a bot check page means no logo: the
// initials stay and nothing is tried around it. Fetched pages are data, never instructions.
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import sharp, { type Metadata, type Sharp } from 'sharp';
import { documentBase } from '../adapters/html.js';
import { db } from '../db.js';
import { optionalEnv, userAgent } from '../env.js';
import { DisallowedError, type FetchResult, HttpError, OutOfScopeError, type RequestBudget, ShopAbortError, ShopFetcher } from '../http/fetcher.js';
import { putObject, r2Configured, r2Writable } from '../r2.js';
import { loadShops } from '../shops.js';
import type { Shop } from '../types.js';
import { IMAGE_CDNS, PHOTO_STORAGE_CAP_BYTES, photoStorage } from './images.js';
import { isPhotoKey, photoKey } from './photo.js';

/** Longest side of a stored logo, in pixels. */
export const LOGO_MAX_SIDE = 128;
/** Requests per shop for the logo job, robots.txt and retries included (the shop's and an image CDN's together). */
export const LOGO_MAX_REQUESTS = 4;
/** A shop whose check failed is looked at again after this many days (or at once with --retry). */
export const LOGO_RECHECK_DAYS = 30;
/** Icons smaller than this are favicons, not logos. */
const MIN_ICON_PX = 96;
const LOGO_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_MAX_BYTES = 10 * 1024 * 1024;
const SVG_MAX_BYTES = 1024 * 1024;
/** Decoded size limit, against decompression bombs. */
const MAX_INPUT_PIXELS = 25_000_000;
/** An SVG is drawn this large on its long side, then shrunk to LOGO_MAX_SIDE (sharp alone would draw it at 72 dpi). */
const SVG_RENDER_SIDE = 512;
const SHARP_TIMEOUT_SECONDS = 10;
const ERROR_MAX = 500;
const RASTER = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff']);

export type LogoSource = 'header' | 'json-ld' | 'icon' | 'og:image';
/** A picture that may be the logo. mustLookLikeLogo: og:image, kept only when square-ish and small once fetched. */
export type LogoCandidate = { source: LogoSource; url: string; mustLookLikeLogo?: true };

const SOURCE_NAMES: Record<LogoSource, string> = {
  header: 'the header image',
  'json-ld': 'the JSON-LD Organization logo',
  icon: 'an icon link',
  'og:image': 'og:image',
};

/** An absolute http(s) address, or null (javascript:, data:, file: and broken addresses are never fetched). */
function httpUrl(raw: string | undefined, base: string): string | null {
  if (!raw || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim(), base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Square-ish (long side at most 1.5 times the short one) and small (at most 600 px): what a logo or icon looks like. */
export function looksLikeLogo(width: number, height: number): boolean {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  return short > 0 && long / short <= 1.5 && long <= 600;
}

const mentionsLogo = (v: string | undefined) => /logo/i.test(v ?? '');

/** The address of an <img>: src unless it is a data: placeholder, else the usual lazy-loading attributes. */
function imgSrc($img: cheerio.Cheerio<never>): string | undefined {
  for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original']) {
    const v = $img.attr(attr)?.trim();
    if (v && !/^data:/i.test(v)) return v;
  }
  const srcset = ($img.attr('srcset') ?? $img.attr('data-srcset'))?.trim();
  return srcset ? srcset.split(',')[0]!.trim().split(/\s+/)[0] : undefined;
}

/** The first <img> in the header, nav or a link to the home page that is named logo (itself or a wrapper). */
function headerLogo($: cheerio.CheerioAPI, base: string, pageUrl: string): string | null {
  const homes = new Set([new URL('/', pageUrl).href, new URL('/', base).href]);
  const isHome = (href: string | undefined) => {
    if (href?.trim() === '/') return true;
    const u = httpUrl(href, base);
    if (!u) return false;
    const x = new URL(u);
    x.hash = '';
    x.search = '';
    return homes.has(x.href);
  };
  for (const el of $('img').toArray()) {
    const $img = $(el) as cheerio.Cheerio<never>;
    const area = $img.closest('header, nav, [role="banner"]');
    const link = $img.closest('a[href]');
    const homeLink = link.length > 0 && isHome(link.attr('href'));
    if (!area.length && !homeLink) continue;
    const src = imgSrc($img);
    if (!src) continue;
    let named = [$img.attr('class'), $img.attr('id'), $img.attr('alt'), src].some(mentionsLogo);
    // a wrapper between the image and its header: <a class="logo"><img></a> (the header itself does not count)
    for (let p = $img.parent(); !named && p.length && p[0] !== area[0]; p = p.parent()) {
      named = mentionsLogo(p.attr('class')) || mentionsLogo(p.attr('id'));
      if (p[0] === link[0]) break;
    }
    if (!named) continue;
    const url = httpUrl(src, base);
    if (url) return url;
  }
  return null;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const ORG_TYPE = /^(Organization|Corporation|OnlineStore|OnlineBusiness|LocalBusiness|[A-Za-z]*Store)$/;

/** The logo of the site's own Organization (or store) in its JSON-LD; a product's brand or maker never counts. */
function jsonLdLogo($: cheerio.CheerioAPI, base: string): string | null {
  const top: Json[] = [];
  const byId = new Map<string, Json>();
  const index = (v: unknown, depth: number) => {
    if (depth > 12) return;
    if (Array.isArray(v)) for (const x of v) index(x, depth + 1);
    else if (isObj(v)) {
      // a bare reference ({"@id": ...}) never replaces the node it points at
      if (typeof v['@id'] === 'string' && Object.keys(v).length > 1) byId.set(v['@id'], v);
      for (const x of Object.values(v)) index(x, depth + 1);
    }
  };
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let doc: unknown;
    try {
      doc = JSON.parse($(el).text().trim());
    } catch {
      continue;
    }
    index(doc, 0);
    for (const d of Array.isArray(doc) ? doc : [doc]) {
      if (!isObj(d)) continue;
      top.push(d);
      if (Array.isArray(d['@graph'])) top.push(...d['@graph'].filter(isObj));
    }
  }
  const logoOf = (v: unknown, depth = 0): string | null => {
    if (depth > 3) return null;
    if (typeof v === 'string') return httpUrl(v, base);
    if (Array.isArray(v)) {
      for (const x of v) {
        const u = logoOf(x, depth + 1);
        if (u) return u;
      }
      return null;
    }
    if (!isObj(v)) return null;
    for (const k of ['url', 'contentUrl']) if (typeof v[k] === 'string') return httpUrl(v[k] as string, base);
    const ref = typeof v['@id'] === 'string' ? byId.get(v['@id']) : undefined;
    return ref && ref !== v ? logoOf(ref, depth + 1) : null;
  };
  for (const node of top) {
    const types = ([] as unknown[]).concat(node['@type'] ?? []).map(String);
    if (!types.some((t) => ORG_TYPE.test(t)) || node.logo === undefined) continue;
    const url = logoOf(node.logo);
    if (url) return url;
  }
  return null;
}

/** apple-touch-icon and icon links of at least 96 px (an SVG icon scales), largest first. */
function iconLinks($: cheerio.CheerioAPI, base: string): string[] {
  const found: { url: string; size: number }[] = [];
  for (const el of $('link[rel][href]').toArray()) {
    const rel = ($(el).attr('rel') ?? '').toLowerCase().split(/\s+/);
    const touch = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
    if (!touch && !rel.includes('icon')) continue;
    const url = httpUrl($(el).attr('href'), base);
    if (!url) continue;
    const sizes = ($(el).attr('sizes') ?? '').toLowerCase();
    const svg = /svg/i.test($(el).attr('type') ?? '') || /\.svg([?#]|$)/i.test(new URL(url).pathname);
    let size = 0;
    for (const m of sizes.matchAll(/(\d+)x(\d+)/g)) size = Math.max(size, Math.min(Number(m[1]), Number(m[2])));
    if (!size && svg) size = Number.MAX_SAFE_INTEGER;
    // an apple-touch-icon without sizes is 180 px by convention
    if (!size && touch) size = 180;
    if (size >= MIN_ICON_PX) found.push({ url, size });
  }
  return found.sort((a, b) => b.size - a.size).map((f) => f.url);
}

/**
 * The pictures of a home page that may be its logo, best first (header image, JSON-LD logo, icons, og:image), and
 * notes on what was passed over (an og:image banner). Addresses are resolved against the page's <base href>.
 */
export function pickLogoCandidates(html: string, pageUrl: string): { candidates: LogoCandidate[]; notes: string[] } {
  const $ = cheerio.load(html);
  const base = documentBase($, pageUrl);
  const notes: string[] = [];
  const out: LogoCandidate[] = [];
  const header = headerLogo($, base, pageUrl);
  if (header) out.push({ source: 'header', url: header });
  const ld = jsonLdLogo($, base);
  if (ld) out.push({ source: 'json-ld', url: ld });
  for (const url of iconLinks($, base)) out.push({ source: 'icon', url });
  const meta = (p: string) => $(`meta[property="${p}"]`).first().attr('content');
  const og = httpUrl(meta('og:image') ?? meta('og:image:secure_url'), base);
  if (og) {
    const w = Number(meta('og:image:width'));
    const h = Number(meta('og:image:height'));
    if (w > 0 && h > 0 && !looksLikeLogo(w, h)) notes.push(`og:image is ${w}x${h}, not logo-like`);
    else out.push({ source: 'og:image', url: og, mustLookLikeLogo: true });
  }
  const seen = new Set<string>();
  return { candidates: out.filter((c) => !seen.has(c.url) && seen.add(c.url)), notes };
}

/** A bot check or firewall page instead of the shop (Cloudflare, Sucuri, Incapsula): no logo, nothing tried around it. */
export function isChallengePage(html: string): boolean {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  if (/^(just a moment|attention required|checking your browser|please wait|access denied)/i.test(title)) return true;
  return /_cf_chl_opt|cf-browser-verification|incapsula incident|sucuri website firewall/i.test(html);
}

const RASTER_DATA_URI = /^data:image\/(png|jpe?g|gif|webp);base64,/i;

/**
 * An SVG with everything that could reach outside it removed, before librsvg sees it (which already refuses external
 * files for an SVG read from memory): the doctype and entities, scripts, foreignObject and embedded documents, event
 * handlers, every href that is not a fragment (#id) or a raster data: image, url() other than url(#id), and @import.
 */
export function sanitizeSvg(text: string): string {
  return text
    .replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, '')
    .replace(/<!ENTITY[\s\S]*?>/gi, '')
    .replace(/<\?xml-stylesheet[\s\S]*?\?>/gi, '')
    .replace(/<(script|foreignObject|iframe|object|embed|audio|video)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|foreignObject|iframe|object|embed|audio|video)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(xlink:href|href)\s*=\s*("([^"]*)"|'([^']*)')/gi, (all, _attr, _q, dq: string | undefined, sq: string | undefined) => {
      const v = (dq ?? sq ?? '').trim();
      return v.startsWith('#') || RASTER_DATA_URI.test(v) ? all : '';
    })
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)\s*([^)'"]*)\1\s*\)/gi, (all, _q, v: string) => (v.trim().startsWith('#') ? all : 'none'));
}

/** True when the bytes are SVG text (an XML declaration, comments or a doctype may come first). */
function isSvgText(buf: Buffer): boolean {
  const head = buf.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
  return head.startsWith('<') && /<svg[\s>]/i.test(head);
}

export type LogoCopy = { body: Buffer; width: number; height: number; bytes: number; contentType: 'image/webp' };

const webp = (s: Sharp) =>
  s
    .webp({ quality: 90, alphaQuality: 100 })
    .timeout({ seconds: SHARP_TIMEOUT_SECONDS })
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }): LogoCopy => ({ body: data, width: info.width, height: info.height, bytes: data.length, contentType: 'image/webp' }));

/**
 * Our stored copy of a logo: WebP, at most 128 px on its long side, transparency kept, no metadata. An SVG is cleaned
 * (sanitizeSvg) and drawn by sharp from memory, with a pixel limit and a timeout. A raster picture keeps its first
 * frame and is never enlarged. mustLookLikeLogo (og:image): refused unless square-ish and small.
 */
export async function makeLogoCopy(original: Buffer, opts: { mustLookLikeLogo?: boolean } = {}): Promise<LogoCopy> {
  if (original.length > LOGO_MAX_BYTES) throw new Error('picture over 5 MB');
  const svg = isSvgText(original);
  if (svg && original.length > SVG_MAX_BYTES) throw new Error('SVG over 1 MB');
  const input = svg ? Buffer.from(sanitizeSvg(original.toString('utf8')), 'utf8') : original;
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (e) {
    throw new Error(/pixel limit/i.test((e as Error).message) ? 'picture has too many pixels' : 'not an image');
  }
  const width = meta.width ?? 0;
  const height = (svg ? meta.height : (meta.pageHeight ?? meta.height)) ?? 0;
  if (!width || !height || (svg ? meta.format !== 'svg' : !meta.format || !RASTER.has(meta.format))) throw new Error('not an image');
  if (opts.mustLookLikeLogo) {
    // an SVG's own size says little; its shape still counts
    const ok = svg ? Math.max(width, height) / Math.min(width, height) <= 1.5 : looksLikeLogo(width, height);
    if (!ok) throw new Error(`picture is ${width}x${height}, not logo-like`);
  }
  if (svg) {
    const density = Math.min(2400, Math.max(1, (72 * SVG_RENDER_SIDE) / Math.max(width, height)));
    return webp(sharp(input, { density, limitInputPixels: MAX_INPUT_PIXELS }).resize({ width: LOGO_MAX_SIDE, height: LOGO_MAX_SIDE, fit: 'inside' }));
  }
  if (width * height > MAX_INPUT_PIXELS) throw new Error('picture has too many pixels');
  return webp(
    sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 })
      .rotate()
      .resize({ width: LOGO_MAX_SIDE, height: LOGO_MAX_SIDE, fit: 'inside', withoutEnlargement: true }),
  );
}

/** One polite GET for the logo job: the home page (kind 'page') or a picture. */
export type LogoGet = (url: string, kind: 'page' | 'image') => Promise<FetchResult>;
export type LogoShop = Pick<Shop, 'id' | 'slug' | 'name' | 'base_url' | 'config'>;

/** passedOver: the better candidates that did not work, and why */
type Found = { ok: true; candidate: LogoCandidate; copy: LogoCopy; sha256: string; passedOver: string[] };
type Missing = { ok: false; error: string };

/** A refusal (401/403), rate limiting (429) or server trouble (5xx), or the request cap: nothing more is tried. */
const stopsTheShop = (e: unknown) =>
  e instanceof ShopAbortError || (e instanceof HttpError && (e.status === 401 || e.status === 403 || e.status === 429 || e.status >= 500));

function why(e: unknown): string {
  if (e instanceof DisallowedError) return `robots.txt disallows ${e.url}`;
  if (e instanceof OutOfScopeError) return `${e.url} is outside the shop's site`;
  if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return `HTTP ${e.status} (refused; no logo, the initials stay)`;
  if (e instanceof HttpError) return `HTTP ${e.status}`;
  return (e as Error).message;
}

/** Reads the shop's home page and returns our copy of the first candidate that works. */
export async function findShopLogo(shop: LogoShop, get: LogoGet): Promise<Found | Missing> {
  let page: FetchResult;
  try {
    page = await get(shop.base_url, 'page');
  } catch (e) {
    return { ok: false, error: `home page: ${why(e)}` };
  }
  if (page.status !== 200) return { ok: false, error: `home page: HTTP ${page.status}` };
  const html = page.text();
  if (isChallengePage(html)) return { ok: false, error: 'home page is a bot check (no logo; nothing is tried around it)' };
  const { candidates, notes } = pickLogoCandidates(html, page.url);
  const tail = notes.length ? `; ${notes.join('; ')}` : '';
  if (!candidates.length) return { ok: false, error: `no logo found on the home page${tail}` };
  const tried: string[] = [];
  for (const c of candidates) {
    try {
      const res = await get(c.url, 'image');
      if (res.status !== 200) {
        tried.push(`${c.source} ${c.url}: HTTP ${res.status}`);
        continue;
      }
      const copy = await makeLogoCopy(res.body, { mustLookLikeLogo: c.mustLookLikeLogo });
      return { ok: true, candidate: c, copy, sha256: createHash('sha256').update(res.body).digest('hex'), passedOver: tried };
    } catch (e) {
      tried.push(`${c.source} ${c.url}: ${why(e)}`);
      if (stopsTheShop(e)) break;
    }
  }
  return { ok: false, error: `no usable logo (${tried.join('; ')})${tail}` };
}

/** $n-parameter SQL as the database owner (postgres.js in production, PGlite in tests). */
export interface LogoDb {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export type LogoJobOptions = { shop?: string; retry?: boolean; dryRun?: boolean };

export type LogoResult =
  | { slug: string; status: 'found'; source: LogoSource; url: string; key: string; width: number; height: number; bytes: number }
  | { slug: string; status: 'none'; error: string }
  /** not recorded (our side: R2 or the storage cap), so the shop is looked at again next time */
  | { slug: string; status: 'skipped'; reason: string };

export interface LogoJobDeps {
  /** null: a dry run without a database (shops must be given) */
  db: LogoDb | null;
  /** the shops to look at, instead of the database's list */
  shops?: LogoShop[];
  /** a polite getter per shop (politeLogoGet in production) */
  getFor(shop: LogoShop): LogoGet;
  /** stores one object in R2; needed unless dryRun */
  put?(key: string, body: Buffer, contentType: string): Promise<void>;
  /** true when R2 is at the storage cap (images.ts PHOTO_STORAGE_CAP_BYTES) */
  storageFull?(): Promise<boolean>;
  log?(msg: string): void;
}

const SHOP_COLUMNS = 'id, slug, name, base_url, config';

/**
 * The shops the job looks at: no logo yet, and never checked, or checked over 30 days ago with an error, or any
 * check with retry. Active shops only, unless one is named (--shop), as elsewhere in the project.
 */
export async function logoShops(q: LogoDb, opts: LogoJobOptions): Promise<LogoShop[]> {
  const rows = await q.query<LogoShop & { config: unknown }>(
    `select ${SHOP_COLUMNS} from shops
     where logo_key is null
       and (($1::text is null and active) or slug = $1::text)
       and ($2::boolean or logo_checked_at is null
            or (logo_error is not null and logo_checked_at < now() - make_interval(days => $3::int)))
     order by slug`,
    [opts.shop ?? null, Boolean(opts.retry), LOGO_RECHECK_DAYS],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), config: (typeof r.config === 'string' ? JSON.parse(r.config) : (r.config ?? {})) as Shop['config'] }));
}

/** Why a named shop is not looked at: unknown, has a logo, or checked recently. */
async function whyNot(q: LogoDb, slug: string): Promise<string> {
  const [row] = await q.query<{ logo_key: string | null; logo_checked_at: unknown }>('select logo_key, logo_checked_at from shops where slug = $1', [slug]);
  if (!row) return `no shop ${slug}`;
  if (row.logo_key) return `${slug} already has a logo (${row.logo_key})`;
  return `${slug} was checked recently (${new Date(row.logo_checked_at as string).toISOString()}); run with --retry to look again`;
}

const clip = (s: string) => (s.length > ERROR_MAX ? `${s.slice(0, ERROR_MAX - 3)}...` : s);

/**
 * The logo job: for each shop (logoShops, or deps.shops), one at a time, find the logo and store our copy, then set
 * logo_key and logo_checked_at; without a logo set logo_error and logo_checked_at. A dry run fetches and reports but
 * stores and records nothing. An R2 failure or the storage cap stops the job without recording anything.
 */
export async function fetchLogos(opts: LogoJobOptions, deps: LogoJobDeps): Promise<LogoResult[]> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const q = deps.db;
  const shops = deps.shops ?? (q ? await logoShops(q, opts) : []);
  if (!shops.length) {
    log(opts.shop && q ? `logos: nothing to do (${await whyNot(q, opts.shop)})` : 'logos: nothing to do');
    return [];
  }
  const results: LogoResult[] = [];
  for (const shop of shops) {
    if (!opts.dryRun && deps.storageFull && (await deps.storageFull())) {
      log(`[${shop.slug}] logo skipped: R2 is at the storage cap (${PHOTO_STORAGE_CAP_BYTES / 1e9} GB); stopping`);
      results.push({ slug: shop.slug, status: 'skipped', reason: 'storage cap' });
      break;
    }
    const found = await findShopLogo(shop, deps.getFor(shop));
    if (!found.ok) {
      log(`[${shop.slug}] no logo: ${found.error}`);
      if (!opts.dryRun && q) await q.query('update shops set logo_checked_at = now(), logo_error = $2 where id = $1', [shop.id, clip(found.error)]);
      results.push({ slug: shop.slug, status: 'none', error: found.error });
      continue;
    }
    const { candidate, copy } = found;
    let key = photoKey(found.sha256);
    const what = `${SOURCE_NAMES[candidate.source]} ${candidate.url} (${copy.width}x${copy.height}, ${copy.bytes} bytes)`;
    if (!opts.dryRun) {
      if (!deps.put || !q) throw new Error('fetchLogos needs a database and R2 unless it is a dry run');
      try {
        // the same picture stored as a product photo (a shop's placeholder is often its logo) is used as it is,
        // never overwritten by the smaller logo copy under the same key
        const [photo] = await q.query<{ r2_key: string }>(`select r2_key from images where sha256 = $1 and r2_key like 'img/%' limit 1`, [found.sha256]);
        if (photo && isPhotoKey(photo.r2_key)) key = photo.r2_key;
        else await deps.put(key, copy.body, copy.contentType);
      } catch (e) {
        log(`[${shop.slug}] R2 upload failed, stopping logos for this run: ${(e as Error).message}`);
        results.push({ slug: shop.slug, status: 'skipped', reason: 'R2 upload failed' });
        break;
      }
      await q.query('update shops set logo_key = $2, logo_checked_at = now(), logo_error = null where id = $1', [shop.id, key]);
    }
    const passed = found.passedOver.length ? ` (passed over: ${found.passedOver.join('; ')})` : '';
    log(`[${shop.slug}] logo from ${what}${opts.dryRun ? ', dry run: not stored' : ` stored as ${key}`}${passed}`);
    results.push({ slug: shop.slug, status: 'found', source: candidate.source, url: candidate.url, key, width: copy.width, height: copy.height, bytes: copy.bytes });
  }
  return results;
}

/**
 * The production getter of one shop: the shop's own ShopFetcher for its pages and pictures, and one fetcher per
 * image CDN host (images.ts IMAGE_CDNS or the shop's config image_hosts) for a logo stored there. All of them share
 * one budget of LOGO_MAX_REQUESTS and keep at least the default 2 to 5 s between requests (a shop's longer gap and
 * robots Crawl-delay win). One retry, after a backoff, on 429, 5xx or a timeout.
 */
export function politeLogoGet(shop: LogoShop, log: (m: string) => void = () => {}): LogoGet {
  const budget: RequestBudget = { max: LOGO_MAX_REQUESTS, used: 0 };
  const common = {
    budget,
    maxRetries: 1,
    minDelayMs: Math.max(2000, Number(shop.config.min_delay_ms ?? 0)),
    maxDelayMs: Math.max(5000, Number(shop.config.max_delay_ms ?? 0)),
  };
  const own = ShopFetcher.fromConfig(shop.config, userAgent(), shop.base_url, log, { ...common, maxBodyBytes: PAGE_MAX_BYTES });
  const hosts = [...IMAGE_CDNS, ...((shop.config.image_hosts as string[] | undefined) ?? [])];
  const cdns = new Map<string, ShopFetcher>();
  const image = { accept: 'image/avif,image/webp,image/svg+xml,image/png,image/*;q=0.8', maxBodyBytes: LOGO_MAX_BYTES };
  return (url, kind) => {
    if (kind === 'page') return own.get(url, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' });
    if (own.inScope(url)) return own.get(url, image);
    const host = new URL(url).hostname.toLowerCase();
    if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return Promise.reject(new Error(`picture host ${host} is not in the allowlist`));
    let f = cdns.get(host);
    if (!f) {
      f = new ShopFetcher({ userAgent: userAgent(), allowedHosts: [host], ...common, maxBodyBytes: LOGO_MAX_BYTES, log });
      cdns.set(host, f);
    }
    return f.get(url, image);
  };
}

/**
 * The job with production wiring (pnpm fetch-logos, and the shop-requests activation for one new shop): the
 * database, R2 and politeLogoGet. Without R2 (or with read-only R2) nothing is fetched or recorded, so the shops are
 * looked at on a later run. A dry run without DATABASE_URL takes the shops from shops.seed.json.
 */
export async function runLogoJob(opts: LogoJobOptions & { log?: (m: string) => void }): Promise<LogoResult[]> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const hasDb = Boolean(optionalEnv('DATABASE_URL'));
  if (!hasDb && !opts.dryRun) throw new Error('DATABASE_URL is not set (a dry run works without it)');
  if (!opts.dryRun && (!r2Configured() || !(await r2Writable()))) {
    log('logos skipped: R2 is not configured or not writable (nothing recorded, the shops are looked at next time)');
    return [];
  }
  const sql = hasDb ? db() : null;
  const shops = sql ? undefined : await loadShops({ shop: opts.shop }, true);
  log(`logos${opts.dryRun ? ' (dry run)' : ''} as ${userAgent()}`);
  return fetchLogos(opts, {
    db: sql ? { query: (text, params = []) => sql.unsafe(text, params as never[]) as never } : null,
    shops,
    getFor: (s) => politeLogoGet(s, (m) => log(`[${s.slug}] ${m}`)),
    put: putObject,
    storageFull: sql
      ? async () => {
          const u = await photoStorage(sql);
          return u.bytes + u.snapshotBytes + 100e6 >= PHOTO_STORAGE_CAP_BYTES;
        }
      : undefined,
    log,
  });
}
