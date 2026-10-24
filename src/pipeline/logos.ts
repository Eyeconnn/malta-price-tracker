// Shop logos (pnpm fetch-logos, migration 016). For each shop without a logo, the home page is read politely and the
// logo picked in this order: an <img> in the header, nav or home link that is named "logo" (class, id, alt, src or a
// wrapper's class or id); the JSON-LD Organization logo; an apple-touch-icon or icon link of at least 96 px; og:image
// only as a last resort and only when it looks like a logo (square-ish and small). Our small copy (WebP, a wordmark
// at most 256 x 64 px, any other at most 128 px, transparency kept) goes to R2 under img/<sha256 of the original>.webp, as product photos do, and the site
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
import type postgres from 'postgres';
import {
  DisallowedError,
  type FetchResult,
  HttpError,
  OutOfScopeError,
  RedirectOutOfScopeError,
  ShopAbortError,
  ShopFetcher,
  TooManyRedirectsError,
} from '../http/fetcher.js';
import { putObject, r2Configured, r2Writable } from '../r2.js';
import { loadShops } from '../shops.js';
import type { Shop } from '../types.js';
import { IMAGE_CDNS, PHOTO_STORAGE_CAP_BYTES, photoStorage } from './images.js';
import { isPhotoKey, photoKey } from './photo.js';

/** Longest side of a stored square-ish logo, in pixels. */
export const LOGO_MAX_SIDE = 128;
/** A logo wider than this (width / height) is a wordmark: stored in a WIDE_MAX_W x WIDE_MAX_H box, drawn as a pill. */
export const WIDE_ASPECT = 1.4;
const WIDE_MAX_W = 256;
const WIDE_MAX_H = 64;
/** Requests to the shop for the logo job, robots.txt, retries and redirect hops included (an image CDN has its own 2). */
export const LOGO_MAX_REQUESTS = 6;
/** A shop whose check failed is looked at again after this many days (or at once with --retry). */
export const LOGO_RECHECK_DAYS = 30;
/** Icons smaller than this are favicons, not logos (declared in the link, and again in the real pixels). */
const MIN_ICON_PX = 96;
/** A logo picture's long side is at least this many pixels (an SVG scales and is exempt). */
const MIN_LOGO_PX = 48;
/** Header and JSON-LD logos: at most this much wider than tall (a wordmark) ... */
const MAX_WIDE_RATIO = 10;
/** ... and at most this much taller than wide. */
const MAX_TALL_RATIO = 4;
/** A logo wider than 4:1 is a wordmark and must be at least this wide (else a favicon serves better). */
const MIN_WORDMARK_W = 120;
/** Icons are square-ish: at most this much wider than tall or taller than wide. */
const MAX_ICON_RATIO = 1.5;
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
/** A picture that may be the logo; its source sets the size checks it must pass once decoded (makeLogoCopy). */
export type LogoCandidate = { source: LogoSource; url: string };

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
    else out.push({ source: 'og:image', url: og });
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

/** SVG elements that run code or pull in other documents: dropped with their content, under any namespace prefix. */
const SVG_DROP = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video', 'handler', 'listener']);
/** The local part of an XML name ("xlink:href" gives "href"), lower case. */
const localName = (name: string) => name.slice(name.lastIndexOf(':') + 1).toLowerCase();

/** CSS without @import and with every url() other than url(#id) made none; null when it uses escapes (which could hide either). */
function cleanCss(css: string): string | null {
  if (css.includes('\\')) return null;
  return css.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*(['"]?)([^)]*?)\1\s*\)/gi, (all, _q, v: string) => (v.trim().startsWith('#') ? all : 'none'));
}

type XmlNode = { type: string; name?: string; attribs?: Record<string, string>; children?: XmlNode[] };

/**
 * An SVG parsed as XML and rebuilt from its root <svg> element with only what draws it: no doctype, entities,
 * comments or processing instructions; no script, foreignObject or embedded documents (under any prefix); no event
 * handlers; no href under any prefix that does not start with "#" (so no external file and no data: picture); and no
 * url() other than url(#id) or @import in styles. librsvg already refuses external files for an SVG read from memory;
 * this does not rely on it. Empty when the document is not an SVG.
 */
export function sanitizeSvg(text: string): string {
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(text, { xml: true });
  } catch {
    return '';
  }
  const root = $.root().children().toArray().find((el) => localName((el as XmlNode).name ?? '') === 'svg') as XmlNode | undefined;
  if (!root) return '';
  const isElement = (n: XmlNode) => n.type === 'tag' || n.type === 'script' || n.type === 'style';
  const cleanAttrs = (el: XmlNode) => {
    for (const [name, value] of Object.entries(el.attribs ?? {})) {
      const local = localName(name);
      const drop =
        local.startsWith('on') || name.toLowerCase() === 'xml:base' || (local === 'href' && !value.trim().startsWith('#')) || /^\s*(javascript|data):/i.test(value);
      if (drop) {
        $(el as never).removeAttr(name);
        continue;
      }
      if (/url\s*\(|@import|\\/i.test(value)) {
        const css = cleanCss(value);
        if (css === null) $(el as never).removeAttr(name);
        else $(el as never).attr(name, css);
      }
    }
  };
  const clean = (el: XmlNode) => {
    for (const child of [...(el.children ?? [])]) {
      if (!isElement(child)) {
        // text stays; comments, directives, processing instructions and CDATA go
        if (child.type !== 'text') $(child as never).remove();
        continue;
      }
      const name = localName(child.name ?? '');
      if (SVG_DROP.has(name)) {
        $(child as never).remove();
        continue;
      }
      cleanAttrs(child);
      if (name === 'style') {
        $(child as never).text(cleanCss($(child as never).text()) ?? '');
        continue;
      }
      clean(child);
    }
  };
  cleanAttrs(root);
  clean(root);
  return $.xml(root as never);
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

/** The decoded picture must look like a logo from its source: why not, or null when it does. */
function sizeProblem(source: LogoSource | undefined, width: number, height: number, svg: boolean): string | null {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const size = `${width}x${height}`;
  if (long <= 1) return `picture is ${size}`;
  if (source === 'icon' && !svg && short < MIN_ICON_PX) return `icon is ${size}, too small (under ${MIN_ICON_PX} px)`;
  // an SVG scales, so only its shape counts
  if (!svg && long < MIN_LOGO_PX) return `picture is ${size}, too small`;
  if (source === 'og:image') {
    const ok = svg ? long / short <= 1.5 : looksLikeLogo(width, height);
    return ok ? null : `picture is ${size}, not logo-like`;
  }
  if (source === 'icon') return long / short > MAX_ICON_RATIO ? `icon is ${size}, not square-ish` : null;
  if (source === 'header' || source === 'json-ld') {
    if (height / width > MAX_TALL_RATIO) return `picture is ${size}, taller than 1:${MAX_TALL_RATIO}`;
    if (width / height > MAX_WIDE_RATIO) return `picture is ${size}, wider than ${MAX_WIDE_RATIO}:1`;
    if (!svg && width / height > MAX_TALL_RATIO && width < MIN_WORDMARK_W) return `picture is ${size}, a wordmark under ${MIN_WORDMARK_W} px wide`;
  }
  return null;
}

/**
 * Our stored copy of a logo: WebP, transparency kept, no metadata; a wide one (over 1.4:1) at most 256 px wide and
 * 64 px tall, any other at most 128 px on its long side. An SVG is cleaned (sanitizeSvg) and drawn by sharp from
 * memory, with a pixel limit and a timeout. A raster picture keeps its first frame and is never enlarged. The decoded
 * size is checked against the source (sizeProblem): never 1x1 or under 48 px on the long side; header and JSON-LD
 * pictures from 1:4 to 10:1 (past 4:1 at least 120 px wide); icons square-ish and at least 96 px whatever their link
 * declared; og:image square-ish and small.
 */
export async function makeLogoCopy(original: Buffer, opts: { source?: LogoSource } = {}): Promise<LogoCopy> {
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
  const problem = sizeProblem(opts.source, width, height, svg);
  if (problem) throw new Error(problem);
  const box = width / height > WIDE_ASPECT ? { width: WIDE_MAX_W, height: WIDE_MAX_H } : { width: LOGO_MAX_SIDE, height: LOGO_MAX_SIDE };
  if (svg) {
    const density = Math.min(2400, Math.max(1, (72 * SVG_RENDER_SIDE) / Math.max(width, height)));
    return webp(sharp(input, { density, limitInputPixels: MAX_INPUT_PIXELS }).resize({ ...box, fit: 'inside' }));
  }
  if (width * height > MAX_INPUT_PIXELS) throw new Error('picture has too many pixels');
  return webp(
    sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 })
      .rotate()
      .resize({ ...box, fit: 'inside', withoutEnlargement: true }),
  );
}

/** One polite GET for the logo job: the home page (kind 'page') or a picture. */
export type LogoGet = (url: string, kind: 'page' | 'image') => Promise<FetchResult>;
export type LogoShop = Pick<Shop, 'id' | 'slug' | 'name' | 'base_url' | 'config'>;

/** passedOver: the better candidates that did not work, and why */
type Found = { ok: true; candidate: LogoCandidate; copy: LogoCopy; sha256: string; passedOver: string[] };
/** transient: rate limiting, server trouble, a timeout or the deadline; not recorded, so the next run looks again */
type Missing = { ok: false; error: string; transient: boolean };

/** robots.txt answered with server errors (so everything is disallowed for now): try again on a later run. */
export class LogoRetryLaterError extends Error {}

/** 429, 5xx, timeouts, network trouble, the deadline: worth another try on a later run, so nothing is recorded. */
export function isTransient(e: unknown): boolean {
  if (e instanceof LogoRetryLaterError) return true;
  if (e instanceof HttpError) return e.status === 408 || e.status === 425 || e.status === 429 || e.status >= 500;
  if (e instanceof ShopAbortError) return /deadline/.test(e.message);
  if (e instanceof DisallowedError || e instanceof OutOfScopeError || e instanceof RedirectOutOfScopeError || e instanceof TooManyRedirectsError) return false;
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|fetch failed|network|terminated/i.test((e as Error)?.message ?? '');
}

/** A refusal (401/403), anything transient, or the request cap: nothing more is tried for the shop. */
const stopsTheShop = (e: unknown) => isTransient(e) || e instanceof ShopAbortError || (e instanceof HttpError && (e.status === 401 || e.status === 403));

function why(e: unknown): string {
  if (e instanceof DisallowedError) return `robots.txt disallows ${e.url}`;
  if (e instanceof OutOfScopeError || e instanceof RedirectOutOfScopeError) return `${e.url} is outside the shop's site and its picture hosts`;
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
    return { ok: false, error: `home page: ${why(e)}`, transient: isTransient(e) };
  }
  if (page.status !== 200) return { ok: false, error: `home page: HTTP ${page.status}`, transient: false };
  const html = page.text();
  if (isChallengePage(html)) return { ok: false, error: 'home page is a bot check (no logo; nothing is tried around it)', transient: false };
  const { candidates, notes } = pickLogoCandidates(html, page.url);
  const tail = notes.length ? `; ${notes.join('; ')}` : '';
  if (!candidates.length) return { ok: false, error: `no logo found on the home page${tail}`, transient: false };
  const tried: string[] = [];
  let transient = false;
  for (const c of candidates) {
    try {
      const res = await get(c.url, 'image');
      if (res.status !== 200) {
        tried.push(`${c.source} ${c.url}: HTTP ${res.status}`);
        continue;
      }
      const copy = await makeLogoCopy(res.body, { source: c.source });
      return { ok: true, candidate: c, copy, sha256: createHash('sha256').update(res.body).digest('hex'), passedOver: tried };
    } catch (e) {
      tried.push(`${c.source} ${c.url}: ${why(e)}`);
      if (stopsTheShop(e)) {
        transient = isTransient(e);
        break;
      }
    }
  }
  return { ok: false, error: `no usable logo (${tried.join('; ')})${tail}`, transient };
}

/** $n-parameter SQL as the database owner (postgres.js in production, PGlite in tests). */
export interface LogoDb {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

/** signal: a hard stop (the activation's deadline); once it fires nothing more is fetched, stored or recorded */
export type LogoJobOptions = { shop?: string; retry?: boolean; dryRun?: boolean; signal?: AbortSignal };

export type LogoResult =
  | { slug: string; status: 'found'; source: LogoSource; url: string; key: string; width: number; height: number; bytes: number }
  | { slug: string; status: 'none'; error: string }
  /** not recorded (rate limiting or a timeout, R2, the storage cap, the deadline, another run), so looked at again later */
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
  /** checked once, only when there is a shop to look at (R2 writable in production); false stops the job */
  ready?(): Promise<boolean>;
  /** true when R2 is at the storage cap (images.ts PHOTO_STORAGE_CAP_BYTES) */
  storageFull?(): Promise<boolean>;
  /**
   * runs fn holding the shop's logo lock (a Postgres advisory lock in production), so the nightly job and the
   * activation never fetch the same shop at once; false when another run holds it (fn not run)
   */
  withShopLock?(shopId: number, fn: () => Promise<void>): Promise<boolean>;
  log?(msg: string): void;
}

const SHOP_COLUMNS = 'id, slug, name, base_url, config';
/** The shops that need a look: no logo, and never checked, or failed over 30 days ago, or any check with retry ($1). */
/**
 * A last check that --retry may repeat: no usable logo among the candidates, or the request cap; never a 401/403
 * refusal or a bot check (those are never worked around), and not a page without any logo.
 */
const RETRYABLE = `((logo_error like 'no usable logo%' or logo_error like '%request cap%')
  and logo_error not like '%HTTP 401%' and logo_error not like '%HTTP 403%' and logo_error not like '%bot check%')`;
const DUE = `logo_key is null and (logo_checked_at is null or ($1::boolean and ${RETRYABLE})
  or (logo_error is not null and logo_checked_at < now() - make_interval(days => ${LOGO_RECHECK_DAYS})))`;

/**
 * The shops the job looks at: no logo yet, and never checked, or checked over 30 days ago with an error, or any
 * check with retry. Active shops only, unless one is named (--shop), as elsewhere in the project.
 */
export async function logoShops(q: LogoDb, opts: LogoJobOptions): Promise<LogoShop[]> {
  const rows = await q.query<LogoShop & { config: unknown }>(
    `select ${SHOP_COLUMNS} from shops where ${DUE} and (($2::text is null and active) or slug = $2::text) order by slug`,
    [Boolean(opts.retry), opts.shop ?? null],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), config: (typeof r.config === 'string' ? JSON.parse(r.config) : (r.config ?? {})) as Shop['config'] }));
}

/** Whether the shop still needs a look (another run may have just done it). */
async function stillDue(q: LogoDb, shopId: number, opts: LogoJobOptions): Promise<boolean> {
  return (await q.query(`select 1 from shops where ${DUE} and id = $2`, [Boolean(opts.retry), shopId])).length > 0;
}

/** Why a named shop is not looked at: unknown, has a logo, or checked recently. */
async function whyNot(q: LogoDb, slug: string): Promise<string> {
  const [row] = await q.query<{ logo_key: string | null; logo_checked_at: unknown; logo_error: string | null }>(
    'select logo_key, logo_checked_at, logo_error from shops where slug = $1',
    [slug],
  );
  if (!row) return `no shop ${slug}`;
  if (row.logo_key) return `${slug} already has a logo (${row.logo_key})`;
  const at = new Date(row.logo_checked_at as string).toISOString();
  const [retryable] = await q.query(`select 1 from shops where slug = $1 and ${RETRYABLE}`, [slug]);
  return retryable
    ? `${slug} was checked recently (${at}); run with --retry to look again`
    : `${slug} was checked recently (${at}) and is not retried (${String(row.logo_error ?? 'no logo')}); it is looked at again ${LOGO_RECHECK_DAYS} days after its check`;
}

const clip = (s: string) => (s.length > ERROR_MAX ? `${s.slice(0, ERROR_MAX - 3)}...` : s);

/**
 * The logo job: for each shop (logoShops, or deps.shops), one at a time and under the shop's logo lock, find the logo
 * and store our copy, then set logo_key and logo_checked_at; with no logo (none found, 401/403, a bot check, nothing
 * usable) set logo_error and logo_checked_at. Rate limiting, server errors, timeouts and the deadline record nothing,
 * so the next run looks again. A dry run fetches and reports but stores and records nothing. An R2 failure or the
 * storage cap stops the job without recording anything.
 */
export async function fetchLogos(opts: LogoJobOptions, deps: LogoJobDeps): Promise<LogoResult[]> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const q = deps.db;
  const shops = deps.shops ?? (q ? await logoShops(q, opts) : []);
  if (!shops.length) {
    log(opts.shop && q ? `logos: nothing to do (${await whyNot(q, opts.shop)})` : 'logos: nothing to do');
    return [];
  }
  if (deps.ready && !(await deps.ready())) return [];
  const stopped = () => opts.signal?.aborted === true;
  const results: LogoResult[] = [];
  let stop = false;

  /** One shop, under its lock. */
  async function one(shop: LogoShop): Promise<LogoResult> {
    if (q && !opts.dryRun && !(await stillDue(q, shop.id, opts))) return { slug: shop.slug, status: 'skipped', reason: 'done by another run' };
    if (!opts.dryRun && deps.storageFull && (await deps.storageFull())) {
      stop = true;
      log(`[${shop.slug}] logo skipped: R2 is at the storage cap (${PHOTO_STORAGE_CAP_BYTES / 1e9} GB); stopping`);
      return { slug: shop.slug, status: 'skipped', reason: 'storage cap' };
    }
    const found = await findShopLogo(shop, deps.getFor(shop));
    if (stopped()) {
      stop = true;
      log(`[${shop.slug}] logo stopped at the deadline (nothing recorded)`);
      return { slug: shop.slug, status: 'skipped', reason: 'deadline' };
    }
    if (!found.ok) {
      if (found.transient) {
        log(`[${shop.slug}] no logo this time, looked at again next run: ${found.error}`);
        return { slug: shop.slug, status: 'skipped', reason: found.error };
      }
      log(`[${shop.slug}] no logo: ${found.error}`);
      if (!opts.dryRun && q) await q.query('update shops set logo_checked_at = now(), logo_error = $2 where id = $1', [shop.id, clip(found.error)]);
      return { slug: shop.slug, status: 'none', error: found.error };
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
        stop = true;
        log(`[${shop.slug}] R2 upload failed, stopping logos for this run: ${(e as Error).message}`);
        return { slug: shop.slug, status: 'skipped', reason: 'R2 upload failed' };
      }
      if (stopped()) {
        stop = true;
        return { slug: shop.slug, status: 'skipped', reason: 'deadline' };
      }
      // a reused product photo is a larger copy of the same picture: its shape is what the site needs
      await q.query('update shops set logo_key = $2, logo_w = $3, logo_h = $4, logo_checked_at = now(), logo_error = null where id = $1', [
        shop.id,
        key,
        copy.width,
        copy.height,
      ]);
    }
    const passed = found.passedOver.length ? ` (passed over: ${found.passedOver.join('; ')})` : '';
    log(`[${shop.slug}] logo from ${what}${opts.dryRun ? ', dry run: not stored' : ` stored as ${key}`}${passed}`);
    return { slug: shop.slug, status: 'found', source: candidate.source, url: candidate.url, key, width: copy.width, height: copy.height, bytes: copy.bytes };
  }

  for (const shop of shops) {
    if (stopped()) break;
    let result: LogoResult | undefined;
    const held = deps.withShopLock && !opts.dryRun ? await deps.withShopLock(shop.id, async () => void (result = await one(shop))) : ((result = await one(shop)), true);
    if (!held || !result) {
      log(`[${shop.slug}] logo skipped: another logo run is fetching this shop`);
      results.push({ slug: shop.slug, status: 'skipped', reason: 'locked by another run' });
      continue;
    }
    results.push(result);
    if (stop) break;
  }
  return results;
}

/** Advisory lock key of the logo job ('LOGO'), with the shop id as the second key. */
export const LOGO_LOCK = 0x4c4f474f;
/** The logo job allows one redirect hop per request (home page, picture, robots.txt). */
export const LOGO_MAX_REDIRECTS = 1;
/** Requests to one image CDN host for a shop's logo: its robots.txt and the picture. */
const CDN_MAX_REQUESTS = 2;

/**
 * The production getter of one shop: the shop's own ShopFetcher for its pages and pictures (LOGO_MAX_REQUESTS to the
 * shop, robots.txt, retries and redirect hops included), and for a logo on an image CDN host (images.ts IMAGE_CDNS or
 * the shop's config image_hosts), named in the page or reached by the shop's one redirect, a fetcher of that host
 * with its own two requests (robots.txt and the picture). At least the default 2 to 5 s between requests (a shop's
 * longer gap and robots Crawl-delay win), at most one redirect hop, one retry after a backoff on 429, 5xx or a
 * timeout. robots.txt answering server errors is LogoRetryLaterError. signal: a hard stop for every wait and request.
 */
export function politeLogoGet(shop: LogoShop, log: (m: string) => void = () => {}, signal?: AbortSignal): LogoGet {
  const common = {
    maxRetries: 1,
    maxRedirects: LOGO_MAX_REDIRECTS,
    minDelayMs: Math.max(2000, Number(shop.config.min_delay_ms ?? 0)),
    maxDelayMs: Math.max(5000, Number(shop.config.max_delay_ms ?? 0)),
    signal,
  };
  const own = ShopFetcher.fromConfig(shop.config, userAgent(), shop.base_url, log, {
    ...common,
    budget: { max: LOGO_MAX_REQUESTS, used: 0 },
    maxBodyBytes: PAGE_MAX_BYTES,
  });
  const hosts = [...IMAGE_CDNS, ...((shop.config.image_hosts as string[] | undefined) ?? [])];
  const cdnHost = (url: string) => {
    const host = new URL(url).hostname.toLowerCase();
    return hosts.some((h) => host === h || host.endsWith(`.${h}`)) ? host : null;
  };
  const cdns = new Map<string, ShopFetcher>();
  const image = { accept: 'image/avif,image/webp,image/svg+xml,image/png,image/*;q=0.8', maxBodyBytes: LOGO_MAX_BYTES };
  /** robots.txt that failed with server errors refuses everything for now: a later run tries again */
  const retryLater = async (f: ShopFetcher, url: string, e: unknown): Promise<never> => {
    if (e instanceof DisallowedError && (await f.robotsFor(url)).status === 'unreachable') throw new LogoRetryLaterError(`robots.txt of ${new URL(url).origin} is unreachable (server errors)`);
    throw e;
  };
  const fromCdn = (url: string, hops: number) => {
    const host = cdnHost(url);
    if (!host) return Promise.reject(new Error(`picture host ${new URL(url).hostname} is not in the allowlist`));
    let f = cdns.get(host);
    if (!f) {
      f = new ShopFetcher({ userAgent: userAgent(), allowedHosts: [host], ...common, budget: { max: CDN_MAX_REQUESTS, used: 0 }, maxBodyBytes: LOGO_MAX_BYTES, log });
      cdns.set(host, f);
    }
    const cdn = f;
    return cdn.get(url, { ...image, maxRedirects: hops }).catch((e: unknown) => retryLater(cdn, url, e));
  };
  return (url, kind) => {
    if (kind === 'page') return own.get(url, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }).catch((e: unknown) => retryLater(own, url, e));
    if (!own.inScope(url)) return fromCdn(url, LOGO_MAX_REDIRECTS);
    // a shop picture that redirects to an allowlisted CDN: that redirect was the one hop, the CDN gets none
    return own.get(url, image).catch((e: unknown) => (e instanceof RedirectOutOfScopeError && cdnHost(e.url) ? fromCdn(e.url, 0) : retryLater(own, url, e)));
  };
}

/** Holds the shop's logo lock for fn: a transaction-level advisory lock (safe behind a connection pooler). */
function shopLock(sql: postgres.Sql) {
  return async (shopId: number, fn: () => Promise<void>): Promise<boolean> => {
    let ran = false;
    await sql.begin(async (tx) => {
      await tx`set local idle_in_transaction_session_timeout = 0`;
      const [{ ok }] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(${LOGO_LOCK}::int, ${shopId}::int) as ok`;
      if (!ok) return;
      ran = true;
      await fn();
    });
    return ran;
  };
}

/**
 * The job with production wiring (pnpm fetch-logos, and the shop-requests activation for one new shop): the
 * database, R2, the per-shop lock and politeLogoGet. R2 is checked only when a shop needs a look; without R2 (or with
 * read-only R2) nothing is fetched or recorded, so the shops are looked at on a later run. A dry run without
 * DATABASE_URL takes the shops from shops.seed.json.
 */
export async function runLogoJob(opts: LogoJobOptions & { log?: (m: string) => void }): Promise<LogoResult[]> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const hasDb = Boolean(optionalEnv('DATABASE_URL'));
  if (!hasDb && !opts.dryRun) throw new Error('DATABASE_URL is not set (a dry run works without it)');
  const sql = hasDb ? db() : null;
  const shops = sql ? undefined : await loadShops({ shop: opts.shop }, true);
  return fetchLogos(opts, {
    db: sql ? { query: (text, params = []) => sql.unsafe(text, params as never[]) as never } : null,
    shops,
    getFor: (s) => politeLogoGet(s, (m) => log(`[${s.slug}] ${m}`), opts.signal),
    put: putObject,
    ready: async () => {
      if (!opts.dryRun && (!r2Configured() || !(await r2Writable()))) {
        log('logos skipped: R2 is not configured or not writable (nothing recorded, the shops are looked at next time)');
        return false;
      }
      log(`logos${opts.dryRun ? ' (dry run)' : ''} as ${userAgent()}`);
      return true;
    },
    storageFull: sql
      ? async () => {
          const u = await photoStorage(sql);
          return u.bytes + u.snapshotBytes + 100e6 >= PHOTO_STORAGE_CAP_BYTES;
        }
      : undefined,
    withShopLock: sql ? shopLock(sql) : undefined,
    log,
  });
}
