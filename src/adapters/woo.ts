import type { Adapter, CrawlContext, KnownProduct, NormalisedRecord } from '../types.js';
import { DisallowedError, HttpError, ShopAbortError } from '../http/fetcher.js';
import { blankRecord, decodeEntities, emptyToNull, minorToCents } from '../util/normalise.js';

interface WooPrices {
  price: string;
  regular_price: string;
  sale_price: string;
  price_range: { min_amount: string; max_amount: string } | null;
  currency_minor_unit: number;
}

interface WooProduct {
  id: number;
  name: string;
  parent: number;
  type: string;
  variation: string;
  permalink: string;
  sku: string;
  on_sale: boolean;
  prices: WooPrices;
  images: { src: string }[];
  categories: { id: number; name: string; slug: string }[];
  tags: { id: number; name: string; slug: string }[];
  brands?: { id: number; name: string; slug: string }[];
  attributes?: { name: string; terms: { name: string }[] }[];
  variations: { id: number; attributes: { name: string; value: string }[] }[];
  is_in_stock: boolean;
}

const API = '/wp-json/wc/store/v1';

function base(ctx: CrawlContext) {
  return ctx.shop.base_url.replace(/\/+$/, '');
}

function brandOf(p: WooProduct): string | null {
  if (p.brands?.length) return decodeEntities(p.brands[0]!.name);
  const attr = p.attributes?.find((a) => /^(brand|brands|manufacturer)$/i.test(a.name));
  return attr?.terms?.[0] ? decodeEntities(attr.terms[0].name) : null;
}

export function wooToRecord(p: WooProduct, parent?: WooProduct): NormalisedRecord {
  const r = blankRecord(String(p.id));
  const src = parent ?? p;
  const unit = p.prices?.currency_minor_unit ?? 2;
  r.parent_external_id = p.parent ? String(p.parent) : null;
  r.url = p.permalink || src.permalink;
  r.sku = emptyToNull(p.sku);
  r.brand = brandOf(src);
  r.title = decodeEntities(parent ? parent.name : p.name);
  r.variant_title = emptyToNull(decodeEntities(p.variation));
  r.category_path = src.categories?.length ? src.categories.map((c) => decodeEntities(c.name)).join(' | ') : null;
  r.tags = (src.tags ?? []).map((t) => decodeEntities(t.name)!).filter(Boolean);
  r.image_url = p.images?.[0]?.src ?? src.images?.[0]?.src ?? null;
  r.price_cents = minorToCents(p.prices?.price, unit);
  const regular = minorToCents(p.prices?.regular_price, unit);
  r.was_price_cents = regular !== null && r.price_cents !== null && regular > r.price_cents ? regular : null;
  r.on_sale = Boolean(p.on_sale) || r.was_price_cents !== null;
  r.in_stock = typeof p.is_in_stock === 'boolean' ? p.is_in_stock : null;
  r.meta = { id: p.id };
  if (p.type === 'variable' && p.prices?.price_range) {
    const lo = minorToCents(p.prices.price_range.min_amount, unit);
    const hi = minorToCents(p.prices.price_range.max_amount, unit);
    r.meta = { ...r.meta, price_range: [lo, hi] };
    r.badge_text = lo !== hi ? 'price range' : null;
  }
  return r;
}

interface PageResult {
  items: WooProduct[];
  totalPages: number | null;
}

async function getPage(ctx: CrawlContext, url: string, retries?: number): Promise<PageResult> {
  const res = await ctx.fetcher.get(url, { retries });
  if (res.status !== 200) throw new HttpError(url, res.status);
  const items = res.json<WooProduct[]>();
  if (!Array.isArray(items)) throw new Error(`unexpected Store API response from ${url}`);
  const tp = res.headers.get('x-wp-totalpages');
  return { items, totalPages: tp ? Number(tp) : null };
}

export const woo: Adapter = {
  async *crawl(ctx: CrawlContext) {
    const b = base(ctx);
    const cfg = ctx.shop.config;
    const adaptive = Boolean(cfg.adaptive_page_size);
    const maxSize = Math.min(Number(cfg.page_size_max ?? (adaptive ? 50 : 100)), 100);
    let size = Math.min(Number(cfg.page_size ?? 100), 100);
    if (ctx.limit) size = Math.min(size, Math.max(ctx.limit, 5));
    let fetched = 0;
    let produced = 0;
    let totalPages: number | null = null;
    let fastStreak = 0;
    const variableParents = new Map<number, WooProduct>();

    while (true) {
      const page = fetched / size + 1;
      const url = `${b}${API}/products?per_page=${size}&page=${page}`;
      const t0 = Date.now();
      let result: PageResult;
      try {
        // adaptive shops retry once at most, then shrink the page instead
        result = await getPage(ctx, url, adaptive && size > 1 ? 1 : undefined);
      } catch (e) {
        if (e instanceof ShopAbortError || e instanceof DisallowedError) throw e;
        if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
          // blocked (e.g. a bot challenge): do not keep knocking
          throw new ShopAbortError(`access denied (HTTP ${e.status}) on ${url}`);
        }
        // Slow servers (AtoZ): retry the same items with a smaller page size.
        const smaller = [10, 5, 2, 1].find((d) => d < size && fetched % d === 0);
        if (adaptive && smaller) {
          ctx.log(`page size ${size} failed (${(e as Error).message}); dropping to ${smaller}`);
          size = smaller;
          fastStreak = 0;
          continue;
        }
        // Skip this page and carry on; the run is marked partial.
        ctx.error(`products page ${page} (size ${size}): ${(e as Error).message}`);
        fetched += size;
        if (totalPages !== null && page >= totalPages) break;
        continue;
      }
      const elapsed = Date.now() - t0;
      if (result.totalPages !== null && fetched === 0) totalPages = result.totalPages;
      const items = result.items;
      if (items.length === 0) break;

      const records: NormalisedRecord[] = [];
      for (const p of items) {
        if (p.type === 'variable' && p.variations?.length) variableParents.set(p.id, p);
        else records.push(wooToRecord(p));
      }
      fetched += items.length;
      produced += records.length;
      if (records.length) yield records;
      ctx.log(`page ${page} x${size}: ${items.length} items in ${(elapsed / 1000).toFixed(1)}s (${fetched} so far)`);
      if (ctx.limit && produced + variableParents.size >= ctx.limit) break;
      if (items.length < size) break;
      if (result.totalPages !== null && page >= result.totalPages) break;

      if (adaptive) {
        fastStreak = elapsed < 15_000 ? fastStreak + 1 : 0;
        if (fastStreak >= 3 && size * 2 <= maxSize && fetched % (size * 2) === 0) {
          size *= 2;
          fastStreak = 0;
          ctx.log(`server is quick, page size up to ${size}`);
        }
      }
    }

    if (variableParents.size) yield* variationRecords(ctx, b, variableParents);
  },

  async fetchOne(ctx: CrawlContext, product: KnownProduct) {
    const b = base(ctx);
    const res = await ctx.fetcher.get(`${b}${API}/products/${encodeURIComponent(product.external_id)}`);
    if (res.status !== 200) return [];
    const p = res.json<WooProduct>();
    if (p.type === 'variation' && p.parent) {
      // Variations carry no categories, tags or brand; mark partial so the stored row keeps its own.
      const r = wooToRecord(p);
      r.meta = { ...r.meta, partial: true };
      return [r];
    }
    return [wooToRecord(p)];
  },
};

/**
 * Variable products: list their variations through the Store API (type=variation) when robots.txt
 * allows it, and record each variation. Parents whose variations we cannot read are recorded
 * themselves, with their minimum price and price range.
 */
async function* variationRecords(ctx: CrawlContext, b: string, parents: Map<number, WooProduct>) {
  const byParent = new Map<number, WooProduct[]>();
  try {
    if (ctx.limit) {
      // small test runs: ask only for the parents we have
      const ids = [...parents.keys()];
      for (let i = 0; i < ids.length; i += 20) {
        const q = ids.slice(i, i + 20).map((id) => `parent[]=${id}`).join('&');
        const { items } = await getPage(ctx, `${b}${API}/products?per_page=100&${q}&type=variation`);
        for (const v of items) push(byParent, v.parent, v);
      }
    } else {
      for (let page = 1; page < 5000; page++) {
        const { items, totalPages } = await getPage(ctx, `${b}${API}/products?per_page=100&page=${page}&type=variation`);
        for (const v of items) if (parents.has(v.parent)) push(byParent, v.parent, v);
        if (items.length < 100 || (totalPages !== null && page >= totalPages)) break;
      }
    }
  } catch (e) {
    if (e instanceof ShopAbortError) throw e;
    if (e instanceof DisallowedError) ctx.log('variation listing blocked by robots.txt; recording parents with price ranges');
    else ctx.error(`variation listing: ${(e as Error).message}`);
  }

  let batch: NormalisedRecord[] = [];
  for (const [id, parent] of parents) {
    const vars = byParent.get(id);
    if (vars?.length) batch.push(...vars.map((v) => wooToRecord(v, parent)));
    else batch.push(wooToRecord(parent));
    if (batch.length >= 100) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/** Product categories, for promo discovery later. */
export async function wooCategories(ctx: CrawlContext) {
  const res = await ctx.fetcher.get(`${base(ctx)}${API}/products/categories`);
  if (res.status !== 200) return [];
  return res.json<{ id: number; name: string; slug: string; parent: number; count: number; link: string }[]>();
}
