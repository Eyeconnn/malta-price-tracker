import type { Adapter, CrawlContext, KnownProduct, NormalisedRecord } from '../types.js';
import { DisallowedError, ShopAbortError } from '../http/fetcher.js';
import { blankRecord, cleanGtin, emptyToNull, toCents } from '../util/normalise.js';

interface ShopifyVariant {
  id: number;
  title: string;
  sku?: string | null;
  barcode?: string | null;
  price: string | number;
  compare_at_price?: string | number | null;
  available?: boolean;
  featured_image?: { src: string } | null;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  vendor?: string;
  product_type?: string;
  type?: string;
  tags?: string[] | string;
  created_at?: string;
  variants: ShopifyVariant[];
  images?: ({ src: string } | string)[];
}

export function baseUrl(base: string): string {
  return base.replace(/\/+$/, '');
}

function tagsOf(t: ShopifyProduct['tags']): string[] {
  if (!t) return [];
  if (Array.isArray(t)) return t.map((s) => s.trim()).filter(Boolean);
  return t.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * products.json gives prices as "69.00" strings; the product .js endpoint gives integer cents.
 * `centsInts` says which one we are reading.
 */
export function shopifyProductToRecords(p: ShopifyProduct, base: string, centsInts = false): NormalisedRecord[] {
  const price = (v: unknown) => (centsInts ? (typeof v === 'number' ? v : null) : toCents(v));
  const firstImage = p.images?.[0];
  const productImage = typeof firstImage === 'string' ? firstImage : firstImage?.src ?? null;
  const many = p.variants.length > 1;
  return p.variants.map((v) => {
    const r = blankRecord(String(v.id));
    r.parent_external_id = String(p.id);
    r.url = `${base}/products/${p.handle}${many ? `?variant=${v.id}` : ''}`;
    r.sku = emptyToNull(v.sku);
    r.gtin = cleanGtin(v.barcode);
    r.brand = emptyToNull(p.vendor);
    r.title = p.title;
    r.variant_title = v.title && v.title !== 'Default Title' ? v.title : null;
    r.category_path = emptyToNull(p.product_type ?? p.type);
    r.tags = tagsOf(p.tags);
    r.image_url = normaliseImageUrl(v.featured_image?.src ?? productImage);
    r.shop_created_at = p.created_at ?? null;
    r.price_cents = price(v.price);
    const compare = price(v.compare_at_price);
    r.was_price_cents = compare && r.price_cents !== null && compare > r.price_cents ? compare : null;
    r.on_sale = r.was_price_cents !== null;
    r.in_stock = typeof v.available === 'boolean' ? v.available : null;
    r.meta = { handle: p.handle };
    return r;
  });
}

function normaliseImageUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  return src.startsWith('//') ? `https:${src}` : src;
}

async function sitemapHandles(ctx: CrawlContext, base: string): Promise<Set<string>> {
  const handles = new Set<string>();
  const index = await ctx.fetcher.get(`${base}/sitemap.xml`, { accept: 'application/xml,text/xml' });
  if (index.status !== 200) return handles;
  const productMaps = [...index.text().matchAll(/<loc>([^<]*sitemap_products_[^<]*)<\/loc>/g)].map((m) =>
    m[1]!.replace(/&amp;/g, '&'),
  );
  for (const url of productMaps) {
    const res = await ctx.fetcher.get(url, { accept: 'application/xml,text/xml' });
    if (res.status !== 200) continue;
    for (const m of res.text().matchAll(/<loc>[^<]*\/products\/([^<?\/]+)<\/loc>/g)) handles.add(decodeURIComponent(m[1]!));
  }
  return handles;
}

export const shopify: Adapter = {
  async *crawl(ctx: CrawlContext) {
    const base = baseUrl(ctx.shop.base_url);
    const pageSize = Math.min(Number(ctx.shop.config.page_size ?? 250), 250);
    const seen = new Set<string>();
    let produced = 0;
    let pagingBroke = false;

    for (let page = 1; page < 1000; page++) {
      let products: ShopifyProduct[];
      try {
        const res = await ctx.fetcher.get(`${base}/products.json?limit=${pageSize}&page=${page}`);
        if (res.status !== 200) {
          ctx.error(`products.json page ${page}: HTTP ${res.status}`);
          pagingBroke = true;
          break;
        }
        products = res.json<{ products: ShopifyProduct[] }>().products ?? [];
      } catch (e) {
        if (e instanceof ShopAbortError) throw e;
        ctx.error(`products.json page ${page}: ${(e as Error).message}`);
        pagingBroke = true;
        break;
      }
      if (products.length === 0) break;
      const records: NormalisedRecord[] = [];
      for (const p of products) {
        seen.add(p.handle);
        records.push(...shopifyProductToRecords(p, base));
      }
      produced += records.length;
      yield records;
      if (ctx.limit && produced >= ctx.limit) return;
      ctx.log(`page ${page}: ${products.length} products, ${produced} variants so far`);
    }

    // Paging can stop early on some stores. Compare with the product sitemap and read the gaps one by one.
    let fromSitemap: Set<string>;
    try {
      fromSitemap = await sitemapHandles(ctx, base);
    } catch (e) {
      if (e instanceof ShopAbortError) throw e;
      ctx.error(`sitemap check failed: ${(e as Error).message}`);
      return;
    }
    const missing = [...fromSitemap].filter((h) => !seen.has(h));
    if (missing.length === 0) return;
    const cap = Number(ctx.shop.config.sitemap_fallback_max ?? 3000);
    ctx.log(
      `${missing.length} products in sitemap but not in products.json${pagingBroke ? ' (paging broke)' : ''}; reading up to ${cap} individually`,
    );
    let batch: NormalisedRecord[] = [];
    for (const handle of missing.slice(0, cap)) {
      try {
        batch.push(...(await fetchByHandle(ctx, base, handle)));
      } catch (e) {
        if (e instanceof ShopAbortError) throw e;
        if (!(e instanceof DisallowedError)) ctx.error(`product ${handle}: ${(e as Error).message}`);
      }
      if (batch.length >= 100) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length) yield batch;
  },

  async fetchOne(ctx: CrawlContext, product: KnownProduct) {
    const base = baseUrl(ctx.shop.base_url);
    const handle =
      (product.meta.handle as string | undefined) ?? product.url?.match(/\/products\/([^?\/#]+)/)?.[1] ?? null;
    if (!handle) throw new Error(`no handle for product ${product.external_id}`);
    return fetchByHandle(ctx, base, handle);
  },
};

/** The .js endpoint carries availability and integer cents; .json is the fallback. */
async function fetchByHandle(ctx: CrawlContext, base: string, handle: string): Promise<NormalisedRecord[]> {
  const js = await ctx.fetcher.get(`${base}/products/${encodeURIComponent(handle)}.js`);
  if (js.status === 200) {
    try {
      const p = js.json<ShopifyProduct & { images: string[] }>();
      return shopifyProductToRecords(p, base, true);
    } catch {
      // fall through to .json
    }
  } else if (js.status === 404 || js.status === 410) {
    return [];
  }
  const res = await ctx.fetcher.get(`${base}/products/${encodeURIComponent(handle)}.json`);
  if (res.status !== 200) return [];
  return shopifyProductToRecords(res.json<{ product: ShopifyProduct }>().product, base);
}

/** Collections list, for promo discovery later. */
export async function shopifyCollections(ctx: CrawlContext) {
  const base = baseUrl(ctx.shop.base_url);
  const out: { id: number; handle: string; title: string; updated_at: string; products_count?: number }[] = [];
  for (let page = 1; page < 100; page++) {
    const res = await ctx.fetcher.get(`${base}/collections.json?limit=250&page=${page}`);
    if (res.status !== 200) break;
    const cols = res.json<{ collections: typeof out }>().collections ?? [];
    if (cols.length === 0) break;
    out.push(...cols);
  }
  return out;
}
