import * as cheerio from 'cheerio';
import type { Adapter, CrawlContext, KnownProduct, NormalisedRecord } from '../types.js';
import { DisallowedError, ShopAbortError, OutOfScopeError } from '../http/fetcher.js';
import { blankRecord, cleanGtin, emptyToNull, toCents } from '../util/normalise.js';
import { firstLdProduct } from './jsonld.js';
import { crawlGraphql, fetchOneGraphql } from './magentoGraphql.js';

/**
 * Magento 2 page crawl.
 * 1. Category URLs come from the homepage menu (and from category pages themselves): any
 *    /catalog/category/view/ link, or a .html link with two or more path segments under the base.
 * 2. Every category page (following "next" pagination) lists products with their final price,
 *    old price, product id, SKU and stock; that is enough for the nightly price.
 * 3. Products we have never read in detail get one product-page read (JSON-LD sku, gtin, mpn,
 *    brand), up to `detail_per_run` (default 400) per night, so a new shop fills in over a few nights.
 *
 * Config: `category_include` / `category_exclude` (regex on URL), `max_categories` (default 600),
 * `list_limit` (adds product_list_limit=N when robots.txt allows it), `detail_per_run`.
 */

interface Listed {
  rec: NormalisedRecord;
  category: string | null;
}

function baseOf(ctx: CrawlContext) {
  return ctx.shop.base_url.replace(/\/+$/, '');
}

/** Absolute URL without query string or fragment, or null if outside the shop. */
function clean(href: string | undefined, pageUrl: string, base: string): string | null {
  if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return null;
  try {
    const u = new URL(href, pageUrl);
    u.hash = '';
    u.search = '';
    const s = u.toString();
    return s.startsWith(base + '/') ? s : null;
  } catch {
    return null;
  }
}

export function isCategoryUrl(url: string, base: string): boolean {
  if (url.includes('/catalog/category/view/')) return true;
  if (/\/(checkout|customer|catalogsearch|wishlist|sales|contact|review)\b/.test(url)) return false;
  const rest = url.slice(base.length + 1);
  return /\.html$/.test(rest) && rest.split('/').length >= 2;
}

function categoryLinks($: cheerio.CheerioAPI, pageUrl: string, base: string): string[] {
  const out = new Set<string>();
  $('a[href]').each((_, a) => {
    const u = clean($(a).attr('href'), pageUrl, base);
    if (u && isCategoryUrl(u, base)) out.add(u);
  });
  return [...out];
}

/** Product tiles on a category page. */
export function parseListing($: cheerio.CheerioAPI, pageUrl: string): Listed[] {
  const category = emptyToNull($('h1.page-title, h1').first().text().replace(/\s+/g, ' '));
  let tiles = $('.products.list .product-item, ol.product-items > li.product-item');
  if (!tiles.length) tiles = $('.product-item');
  const out: Listed[] = [];
  tiles.each((_, el) => {
    const t = $(el);
    const link = t.find('a.product-item-link').first();
    const href = link.attr('href');
    if (!href) return;
    const url = new URL(href, pageUrl).toString().split('#')[0]!;
    // product id: price box, else the wishlist/compare data-post JSON, else the price-box element id
    const pid =
      t.find('[data-product-id]').first().attr('data-product-id') ??
      /&quot;product&quot;:(\d+)|"product":(\d+)/.exec($.html(el))?.slice(1).find(Boolean) ??
      /product-price-(\d+)/.exec($.html(el))?.[1];
    const rec = blankRecord(pid ? String(pid) : url);
    rec.url = url;
    rec.title = emptyToNull(link.text().replace(/\s+/g, ' '));
    rec.sku = emptyToNull(t.find('[data-product-sku]').first().attr('data-product-sku')) ?? emptyToNull(t.find('.product-item-sku .value').first().text());
    rec.price_cents = toCents(t.find('[data-price-type="finalPrice"]').first().attr('data-price-amount'));
    const old = toCents(t.find('[data-price-type="oldPrice"]').first().attr('data-price-amount'));
    rec.was_price_cents = old && rec.price_cents !== null && old > rec.price_cents ? old : null;
    rec.on_sale = rec.was_price_cents !== null;
    const stockText = t.find('.stock').text().toLowerCase();
    if (/out of stock|unavailable/.test(stockText)) rec.in_stock = false;
    else if (t.find('button.tocart, .action.tocart').length || /in stock/.test(stockText)) rec.in_stock = true;
    const badge = emptyToNull(t.find('.product-label, .sale-label, .discount-label, [class*="badge"]').first().text().replace(/\s+/g, ' '));
    rec.badge_text = badge && !/^SKU:?$/i.test(badge) ? badge : null;
    const img = t.find('img.product-image-photo').first();
    rec.image_url = img.attr('data-lazysrc') ?? img.attr('data-src') ?? (img.attr('src')?.startsWith('data:') ? null : img.attr('src')) ?? null;
    rec.meta = { listing: true };
    out.push({ rec, category });
  });
  return out;
}

function nextPage($: cheerio.CheerioAPI, pageUrl: string): string | null {
  const href = $('.pages-item-next a, a.action.next').first().attr('href');
  return href ? new URL(href, pageUrl).toString() : null;
}

/** Reads a product page: JSON-LD identifiers, data-price-amount prices, stock. */
export function parseProductPage(html: string, url: string): NormalisedRecord | null {
  const $ = cheerio.load(html);
  const ld = firstLdProduct($);
  const main = $('.product-info-main').length ? $('.product-info-main') : $('body');
  const pid =
    main.find('[data-product-id]').first().attr('data-product-id') ??
    $('#product_addtocart_form input[name="product"]').attr('value') ??
    null;
  if (!pid && !ld) return null;
  const r = blankRecord(pid ? String(pid) : url);
  r.url = url;
  r.title = ld?.name ?? emptyToNull($('h1.page-title, h1').first().text().replace(/\s+/g, ' '));
  r.sku = ld?.sku ?? emptyToNull(main.find('[itemprop="sku"], .product.attribute.sku .value').first().text());
  const attrs = attributeTable($);
  r.gtin = ld?.gtin ?? cleanGtin(attrs.find(([k]) => /\b(ean|gtin|barcode|upc)\b/i.test(k))?.[1]) ?? null;
  r.mpn = ld?.mpn ?? attrs.find(([k]) => /manufacturer code|\bmpn\b|part (no|number)|manufacturer part/i.test(k))?.[1] ?? null;
  r.brand = ld?.brand ?? attrs.find(([k]) => /^(manufacturer|brand)$/i.test(k))?.[1] ?? null;
  r.image_url = ld?.image ?? $('meta[property="og:image"]').attr('content') ?? null;
  r.category_path = ld?.category ?? null;
  r.price_cents = toCents(main.find('[data-price-type="finalPrice"]').first().attr('data-price-amount')) ?? ld?.price_cents ?? null;
  const old = toCents(main.find('[data-price-type="oldPrice"]').first().attr('data-price-amount'));
  r.was_price_cents = old && r.price_cents !== null && old > r.price_cents ? old : null;
  r.on_sale = r.was_price_cents !== null;
  const stock = main.find('.stock').first();
  if (stock.hasClass('unavailable') || /out of stock/i.test(stock.text())) r.in_stock = false;
  else if (stock.hasClass('available') || /in stock/i.test(stock.text())) r.in_stock = true;
  else r.in_stock = ld?.in_stock ?? null;
  r.meta = { detailed: new Date().toISOString().slice(0, 10) };
  return r;
}

/** Label/value rows of the product attributes table ("More Information" tab). */
function attributeTable($: cheerio.CheerioAPI): [string, string][] {
  const out: [string, string][] = [];
  $('.additional-attributes tr, #product-attribute-specs-table tr').each((_, tr) => {
    const k = $(tr).find('th').first().text().trim();
    const v = $(tr).find('td').first().text().replace(/\s+/g, ' ').trim();
    if (k && v) out.push([k, v]);
  });
  return out;
}

function mergeDetail(listing: NormalisedRecord, detail: NormalisedRecord | null): NormalisedRecord {
  if (!detail) return listing;
  return {
    ...listing,
    sku: listing.sku ?? detail.sku,
    in_stock: detail.in_stock ?? listing.in_stock,
    price_cents: listing.price_cents ?? detail.price_cents,
    gtin: detail.gtin,
    mpn: detail.mpn,
    brand: detail.brand,
    title: listing.title ?? detail.title,
    image_url: detail.image_url ?? listing.image_url,
    category_path: detail.category_path ?? listing.category_path,
    meta: { ...listing.meta, ...detail.meta },
  };
}

export const magento: Adapter = {
  async *crawl(ctx: CrawlContext) {
    if (ctx.shop.config.graphql) {
      yield* crawlGraphql(ctx);
      return;
    }
    const base = baseOf(ctx);
    const cfg = ctx.shop.config;
    const include = cfg.category_include ? new RegExp(String(cfg.category_include)) : null;
    const exclude = cfg.category_exclude ? new RegExp(String(cfg.category_exclude)) : null;
    const maxCategories = Number(cfg.max_categories ?? 600);
    const listLimit = cfg.list_limit ? Number(cfg.list_limit) : null;
    const accept = (u: string) => (!include || include.test(u)) && !(exclude && exclude.test(u));

    const home = await ctx.fetcher.get(`${base}/`, { accept: 'text/html' });
    if (home.status !== 200) throw new Error(`homepage returned HTTP ${home.status}`);
    const queue = categoryLinks(cheerio.load(home.text()), home.url, base).filter(accept);
    const seenCats = new Set(queue);
    const products = new Map<string, Listed>();
    ctx.log(`${queue.length} category links on the homepage`);

    for (let i = 0; i < queue.length && i < maxCategories; i++) {
      let pageUrl: string | null = listLimit ? `${queue[i]}?product_list_limit=${listLimit}` : queue[i]!;
      let pages = 0;
      while (pageUrl && pages < 100) {
        let res;
        try {
          res = await ctx.fetcher.get(pageUrl, { accept: 'text/html' });
        } catch (e) {
          if (e instanceof ShopAbortError) throw e;
          if (!(e instanceof DisallowedError) && !(e instanceof OutOfScopeError)) ctx.error(`category ${pageUrl}: ${(e as Error).message}`);
          break;
        }
        if (res.status !== 200) break;
        const $ = cheerio.load(res.text());
        for (const item of parseListing($, res.url)) {
          if (!products.has(item.rec.external_id)) {
            item.rec.category_path = item.category;
            products.set(item.rec.external_id, item);
          }
        }
        if (pages === 0) {
          for (const c of categoryLinks($, res.url, base)) {
            if (!seenCats.has(c) && accept(c)) {
              seenCats.add(c);
              queue.push(c);
            }
          }
        }
        pages++;
        const next = nextPage($, res.url);
        pageUrl = next && next !== pageUrl ? next : null;
        if (ctx.limit && products.size >= ctx.limit) break;
      }
      if (ctx.limit && products.size >= ctx.limit) break;
      if (i % 25 === 0) ctx.log(`category ${i + 1}/${Math.min(queue.length, maxCategories)}: ${products.size} products so far`);
    }
    ctx.log(`${products.size} products from the category pages`);

    // Products never read in detail get one product-page read, within the nightly budget.
    let all = [...products.values()].map((p) => p.rec);
    if (ctx.limit) all = all.slice(0, ctx.limit);
    const ids = all.map((r) => r.external_id);
    let needy = new Set<string>();
    if (ctx.needsDetail) {
      for (let i = 0; i < ids.length; i += 1000) for (const id of await ctx.needsDetail(ids.slice(i, i + 1000))) needy.add(id);
    } else {
      needy = new Set(ids);
    }
    const budget = ctx.limit ?? Number(cfg.detail_per_run ?? 400);
    const toDetail = all.filter((r) => needy.has(r.external_id)).slice(0, budget);
    const detailIds = new Set(toDetail.map((r) => r.external_id));
    yield all.filter((r) => !detailIds.has(r.external_id));
    if (toDetail.length) ctx.log(`reading ${toDetail.length} product pages for identifiers (${needy.size} still need one)`);

    let batch: NormalisedRecord[] = [];
    for (let i = 0; i < toDetail.length; i++) {
      const r = toDetail[i]!;
      let detail: NormalisedRecord | null = null;
      try {
        const res = await ctx.fetcher.get(r.url!, { accept: 'text/html' });
        if (res.status === 200) detail = parseProductPage(res.text(), res.url);
      } catch (e) {
        if (e instanceof ShopAbortError) {
          // keep the listing prices of everything not yet detailed
          yield [...batch, ...toDetail.slice(i)];
          throw e;
        }
        if (!(e instanceof DisallowedError)) ctx.error(`product ${r.url}: ${(e as Error).message}`);
      }
      batch.push(mergeDetail(r, detail));
      if (batch.length >= 50) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length) yield batch;
  },

  async fetchOne(ctx: CrawlContext, product: KnownProduct) {
    if (ctx.shop.config.graphql) return fetchOneGraphql(ctx, product);
    if (!product.url) throw new Error(`no URL for product ${product.external_id}`);
    const res = await ctx.fetcher.get(product.url, { accept: 'text/html' });
    if (res.status !== 200) return [];
    const r = parseProductPage(res.text(), res.url);
    if (!r) return [];
    r.external_id = product.external_id;
    return [r];
  },
};
