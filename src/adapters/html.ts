import * as cheerio from 'cheerio';
import type { Adapter, CrawlContext, KnownProduct, NormalisedRecord } from '../types.js';
import { DisallowedError, OutOfScopeError, ShopAbortError } from '../http/fetcher.js';
import { blankRecord, cleanGtin, emptyToNull, toCents } from '../util/normalise.js';
import { firstLdProduct } from './jsonld.js';

/**
 * Generic HTML shop, driven by `config.html` in shops.seed.json:
 *
 *   start_urls       pages whose links list the categories (default: the base URL)
 *   category_links   CSS selector for category links on those pages
 *   category_pattern regex the category URL must match (applied after query strings are removed)
 *   normalise        optional [regex, replacement] applied to category URLs (e.g. force page 1, size 24)
 *   page_url         template for page N of a category: "{url}?pagenumber={page}" or a regex rewrite
 *                    given as [regex, replacement-with-{page}]
 *   last_page        selector whose numbers (text or data-page) give the last page number
 *   tile, link, title, brand, sku, price, old_price, stock   selectors inside a listing tile
 *   image            optional selector of the tile's main picture (default: its first img); lazy-loaded addresses are
 *                    read from data-src, data-lazysrc or data-lazyloadsrc before src
 *   id               { attr: "data-productid" } on the tile, or { url_regex: "/webshop/(\\d+)/" }
 *   in_stock / out_of_stock   regexes for the stock text
 *   own_text         list of field names whose value is the element's own text (no child elements)
 *   product          the same field names for a product page (used by fetchOne)
 *
 * JSON-LD on product pages is always tried first.
 */
interface Fields {
  title?: string;
  brand?: string;
  sku?: string;
  gtin?: string;
  price?: string;
  old_price?: string;
  stock?: string;
}

interface HtmlConfig extends Fields {
  start_urls?: string[];
  category_links: string;
  category_pattern?: string;
  normalise?: [string, string];
  page_url?: string | [string, string];
  last_page?: string;
  max_pages?: number;
  max_categories?: number;
  tile: string;
  link: string;
  image?: string;
  id?: { attr?: string; url_regex?: string };
  in_stock?: string;
  out_of_stock?: string;
  own_text?: string[];
  product?: Fields & { id?: { attr?: string; selector?: string; url_regex?: string } };
}

function cfgOf(ctx: CrawlContext): HtmlConfig {
  const c = ctx.shop.config.html as HtmlConfig | undefined;
  if (!c) throw new Error(`shop ${ctx.shop.slug} has no config.html`);
  return c;
}

function baseOf(ctx: CrawlContext) {
  return ctx.shop.base_url.replace(/\/+$/, '');
}

function abs(href: string | undefined, pageUrl: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, pageUrl);
    u.hash = '';
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * The address relative links on a page resolve against: its <base href> when that is an http(s) address on the
 * page's own site (Telecom writes image paths relative to <base href="https://www.telecom.com.mt/">), else the page.
 */
export function documentBase($: cheerio.CheerioAPI, pageUrl: string): string {
  const href = $('base[href]').first().attr('href');
  if (!href) return pageUrl;
  try {
    const page = new URL(pageUrl);
    const base = new URL(href, pageUrl);
    if ((base.protocol !== 'https:' && base.protocol !== 'http:') || base.hostname !== page.hostname) return pageUrl;
    return base.toString();
  } catch {
    return pageUrl;
  }
}

function text($: cheerio.CheerioAPI, scope: cheerio.Cheerio<never>, sel: string | undefined, own = false): string | null {
  if (!sel) return null;
  const el = scope.find(sel).first();
  if (!el.length) return null;
  const t = own ? el.contents().filter((_, n) => n.type === 'text').text() : el.text();
  return emptyToNull(t.replace(/\s+/g, ' '));
}

/** A tile picture's address: a lazy-loading attribute first (nopCommerce writes data-lazyloadsrc), never a data: placeholder. */
export function tileImage(img: { attr(name: string): string | undefined }): string | undefined {
  for (const attr of ['data-src', 'data-lazysrc', 'data-lazyloadsrc', 'src']) {
    const v = img.attr(attr)?.trim();
    if (v && !v.startsWith('data:')) return v;
  }
  return undefined;
}

function stockFrom(t: string | null, c: HtmlConfig): boolean | null {
  if (!t) return null;
  if (c.out_of_stock && new RegExp(c.out_of_stock, 'i').test(t)) return false;
  if (c.in_stock && new RegExp(c.in_stock, 'i').test(t)) return true;
  return null;
}

function pageUrl(c: HtmlConfig, url: string, page: number): string {
  if (!c.page_url) return url;
  // a string template applies to page 1 too (it may carry a page size); a regex rewrite only from page 2
  if (typeof c.page_url === 'string') return c.page_url.replace('{url}', url).replace('{page}', String(page));
  if (page === 1) return url;
  return url.replace(new RegExp(c.page_url[0]), c.page_url[1].replace('{page}', String(page)));
}

function lastPage($: cheerio.CheerioAPI, c: HtmlConfig): number {
  if (!c.last_page) return 1;
  let max = 1;
  $(c.last_page).each((_, el) => {
    for (const v of [$(el).attr('data-page'), $(el).text()]) {
      const n = Number(String(v ?? '').trim());
      if (Number.isInteger(n) && n > max) max = n;
    }
  });
  return max;
}

export function parseTiles($: cheerio.CheerioAPI, page: string, c: HtmlConfig): NormalisedRecord[] {
  const own = new Set(c.own_text ?? []);
  const out: NormalisedRecord[] = [];
  const base = documentBase($, page);
  $(c.tile).each((_, el) => {
    const t = $(el) as unknown as cheerio.Cheerio<never>;
    const url = abs(t.find(c.link).first().attr('href'), base);
    if (!url) return;
    let id: string | null = null;
    if (c.id?.attr) id = t.attr(c.id.attr) ?? t.find(`[${c.id.attr}]`).first().attr(c.id.attr) ?? null;
    if (!id && c.id?.url_regex) id = new RegExp(c.id.url_regex).exec(url)?.[1] ?? null;
    const r = blankRecord(id ?? url);
    r.url = url;
    r.title = text($, t, c.title, own.has('title')) ?? emptyToNull(t.find(c.link).first().text().replace(/\s+/g, ' '));
    r.brand = text($, t, c.brand, own.has('brand'));
    r.sku = text($, t, c.sku, own.has('sku'));
    r.price_cents = toCents(text($, t, c.price, own.has('price')));
    const old = toCents(text($, t, c.old_price, own.has('old_price')));
    r.was_price_cents = old && r.price_cents !== null && old > r.price_cents ? old : null;
    r.on_sale = r.was_price_cents !== null;
    r.in_stock = stockFrom(text($, t, c.stock, own.has('stock')), c);
    r.image_url = abs(tileImage(c.image ? t.find(c.image).first() : t.find('img').first()), base);
    out.push(r);
  });
  return out;
}

export function parseProduct(html: string, url: string, c: HtmlConfig): NormalisedRecord | null {
  const $ = cheerio.load(html);
  const p = c.product ?? {};
  const body = $('body') as unknown as cheerio.Cheerio<never>;
  const ld = firstLdProduct($);
  let id: string | null = null;
  if (p.id?.selector && p.id.attr) id = $(p.id.selector).first().attr(p.id.attr) ?? null;
  if (!id && p.id?.url_regex) id = new RegExp(p.id.url_regex).exec(url)?.[1] ?? null;
  const r = blankRecord(id ?? url);
  r.url = url;
  r.title = ld?.name ?? text($, body, p.title ?? 'h1');
  r.brand = ld?.brand ?? text($, body, p.brand);
  r.sku = ld?.sku ?? text($, body, p.sku);
  r.gtin = ld?.gtin ?? cleanGtin(text($, body, p.gtin));
  r.mpn = ld?.mpn ?? null;
  r.price_cents = toCents(text($, body, p.price)) ?? ld?.price_cents ?? null;
  const old = toCents(text($, body, p.old_price));
  r.was_price_cents = old && r.price_cents !== null && old > r.price_cents ? old : null;
  r.on_sale = r.was_price_cents !== null;
  r.in_stock = stockFrom(text($, body, p.stock), c) ?? ld?.in_stock ?? null;
  r.image_url = abs(ld?.image ?? $('meta[property="og:image"]').attr('content'), documentBase($, url));
  return r.price_cents === null && !ld ? null : r;
}

export const html: Adapter = {
  async *crawl(ctx: CrawlContext) {
    const c = cfgOf(ctx);
    const base = baseOf(ctx);
    const pattern = c.category_pattern ? new RegExp(c.category_pattern) : null;
    const maxPages = c.max_pages ?? 300;
    const maxCats = c.max_categories ?? 400;

    // 1. category URLs
    const cats = new Set<string>();
    for (const start of c.start_urls?.map((u) => abs(u, base + '/')!) ?? [base + '/']) {
      const res = await ctx.fetcher.get(start, { accept: 'text/html' });
      if (res.status !== 200) throw new Error(`start page ${start} returned HTTP ${res.status}`);
      const $ = cheerio.load(res.text());
      $(c.category_links).each((_, a) => {
        let u = abs($(a).attr('href'), documentBase($, res.url));
        if (!u) return;
        if (c.normalise) u = u.replace(new RegExp(c.normalise[0]), c.normalise[1]);
        const noQuery = u.split('?')[0]!;
        if (!pattern || pattern.test(noQuery)) cats.add(c.normalise ? u : noQuery);
      });
    }
    ctx.log(`${cats.size} category URLs`);

    // 2. listing pages
    const seen = new Set<string>();
    let produced = 0;
    let catIndex = 0;
    for (const cat of [...cats].slice(0, maxCats)) {
      catIndex++;
      let last = 1;
      for (let page = 1; page <= last && page <= maxPages; page++) {
        const url = pageUrl(c, cat, page);
        let res;
        try {
          res = await ctx.fetcher.get(url, { accept: 'text/html' });
        } catch (e) {
          if (e instanceof ShopAbortError) throw e;
          if (!(e instanceof DisallowedError) && !(e instanceof OutOfScopeError)) ctx.error(`listing ${url}: ${(e as Error).message}`);
          break;
        }
        if (res.status !== 200) break;
        const $ = cheerio.load(res.text());
        if (page === 1) last = lastPage($, c);
        const fresh = parseTiles($, res.url, c).filter((r) => !seen.has(r.external_id));
        for (const r of fresh) seen.add(r.external_id);
        if (fresh.length) {
          const batch = ctx.limit ? fresh.slice(0, ctx.limit - produced) : fresh;
          produced += batch.length;
          yield batch;
        }
        if (ctx.limit && produced >= ctx.limit) return;
      }
      if (catIndex % 20 === 0) ctx.log(`category ${catIndex}/${cats.size}: ${produced} products so far`);
    }
  },

  async fetchOne(ctx: CrawlContext, product: KnownProduct) {
    if (!product.url) throw new Error(`no URL for product ${product.external_id}`);
    const res = await ctx.fetcher.get(product.url, { accept: 'text/html' });
    if (res.status !== 200) return [];
    const r = parseProduct(res.text(), res.url, cfgOf(ctx));
    if (!r) return [];
    r.external_id = product.external_id;
    r.meta = { partial: true }; // product pages here do not carry the listing's category context
    return [r];
  },
};
