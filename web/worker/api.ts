// API router. Access control already ran (index.ts); this validates parameters, calls Data and caches.
// Every read except search is cached for 10 minutes (cache.ts; while the site is private only in the browser);
// errors propagate to the handler's generic 500.
// Search gives one result per product (design Part 3); /api/product/:key is the product page (every trusted
// seller of one product), /api/products/:id the older one-listing page (its `key` leads to the product page).
// The one public write, POST /api/reports, is handed to reports.ts before any read routing and is never cached.
// /api/admin/* goes to admin.ts (its own auth check, the site_admin role, never cached).
import { SITE_CATEGORIES } from '../../src/site/categories.js';
import { computeRating } from '../../src/site/rating.js';
import { specsSummary } from '../../src/site/identity.js';
import { attributeList, type Listing, optionLabel, productName } from '../../src/site/product.js';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';
import type { VerdictFacts } from '../../src/site/verdict.js';
import { type AdminDeps, DEFAULT_ADMIN, handleAdmin } from './admin.js';
import { type ResponseCache, cached as cachedResponse } from './cache.js';
import type { Data, Label, ProductGroup, SearchHit, SearchPattern, Seller, SellerHistoryObs } from './data.js';
import type { Env } from './env.js';
import { json } from './http.js';
import { DEFAULT_REPORTS, handleReport, type ReportDeps } from './reports.js';
import type { AccessSettings } from './settings.js';

export interface ApiDeps {
  data: (env: Env) => Data;
  cache: () => ResponseCache | null;
  /** report store (site_reporter role) and Turnstile fetch; defaults to Neon and the global fetch */
  reports?: ReportDeps;
  /** admin store (site_admin role); defaults to Neon */
  admin?: AdminDeps;
}

const PAGE_SIZE = 24;
const MAX_PAGE = 10_000;
const MAX_EUROS = 100_000;
const HOME_CARDS = 6;
const SHOP_CARDS = 5;
const SEARCH_MIN = 2;
const SEARCH_MAX = 120;
const SEARCH_GROUPS = 40;

const CATEGORY_SLUGS = new Set<string>(SITE_CATEGORIES.map((c) => c.slug));
const SLUG = /^[a-z0-9-]{1,64}$/;

const notFound = () => json({ error: 'not found' }, 404);
const badRequest = (error: string) => json({ error }, 400);

/**
 * The search text: control characters removed, trimmed, cut to 120 code points and trimmed again; null when
 * under 2 characters. `like` is the text as an ILIKE substring pattern with \, % and _ escaped.
 */
export function searchPattern(raw: string): SearchPattern | null {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const text = Array.from(cleaned).slice(0, SEARCH_MAX).join('').trim();
  if (Array.from(text).length < SEARCH_MIN) return null;
  return { text, like: `%${text.replace(/[\\%_]/g, '\\$&')}%` };
}

/** Optional slug parameter: null when absent or empty, undefined when malformed. */
function slugParam(url: URL, name: string): string | null | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === '') return null;
  return SLUG.test(v) ? v : undefined;
}

/**
 * One search result: a product (its canonical group, or one listing alone), never one shop's row (design Part 3).
 * key: the product page (/product/<key>). name: the clean name the listings agree on, else the best hit's shop
 * title; specs: its identity specs the name does not carry ("256GB"). priceCents: the lowest price of a seller
 * not known to be out of stock, else the lowest price (inStock false), null when no seller shows one (never 0).
 * shop: the one shop when only one sells it. good / avoid: how many sellers have that verdict (verdicts stay per
 * seller, never merged into one product verdict).
 */
export type ProductResult = {
  key: string;
  name: string;
  specs: string | null;
  priceCents: number | null;
  inStock: boolean;
  shops: number;
  shop: string | null;
  bf: boolean;
  imageUrl: string | null;
  good: number;
  avoid: number;
};

/** A link or image address from scraped data, only when it is plain http(s) (no user name or password). */
export function webAddress(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** The lowest positive price of the rows not known out of stock, else of all rows. */
function lowestPrice(rows: { priceCents: number | null; inStock: boolean | null }[]): { priceCents: number | null; inStock: boolean } {
  const min = (list: typeof rows) => list.reduce<number | null>((m, r) => (positive(r.priceCents) && (m === null || r.priceCents < m) ? r.priceCents : m), null);
  const stocked = rows.filter((r) => r.inStock !== false);
  const inStockPrice = min(stocked);
  if (inStockPrice !== null) return { priceCents: inStockPrice, inStock: true };
  return { priceCents: min(rows), inStock: stocked.length > 0 };
}

const listingOf = (r: { shopSlug: string; title: string; displayName: string | null; nameCategory: string | null; attrs: Record<string, unknown> | null }): Listing => ({
  shopSlug: r.shopSlug,
  title: r.title,
  displayName: r.displayName,
  category: r.nameCategory,
  attrs: r.attrs,
});

/** Hits as products in data order (best hit first, max 40); the members of a group are the rows data found for it. */
export function productResults(hits: SearchHit[]): ProductResult[] {
  const groups = new Map<string, { title: string; rows: SearchHit[] }>();
  for (const h of hits) {
    let g = groups.get(h.groupKey);
    if (!g) {
      if (groups.size >= SEARCH_GROUPS) continue;
      g = { title: h.groupTitle, rows: [] };
      groups.set(h.groupKey, g);
    }
    g.rows.push(h);
  }
  return [...groups.entries()].map(([key, g]) => {
    const { name, category, attrs } = productName(g.rows.map(listingOf), g.title);
    const shops = new Set(g.rows.map((r) => r.shopSlug));
    return {
      key,
      name,
      specs: specsSummary(category, attrs, name),
      ...lowestPrice(g.rows),
      shops: shops.size,
      shop: shops.size === 1 ? g.rows[0].shop : null,
      bf: g.rows.some((r) => r.bf),
      imageUrl: g.rows.map((r) => webAddress(r.imageUrl)).find((u) => u !== null) ?? null,
      good: g.rows.filter((r) => r.verdict === 'good').length,
      avoid: g.rows.filter((r) => r.verdict === 'avoid').length,
    };
  });
}

/** Where the same product is cheaper (a seller of the same product, in stock, at least cheaperPct cheaper). */
export type SellerCheaper = { id: number; shop: string; shopSlug: string; priceCents: number };
/** One seller on the product page. url: http(s) only. verdict: this seller's own (a was price is one shop's claim). */
export type SellerView = Omit<Seller, 'groupKey' | 'shopId' | 'brand' | 'imageUrl' | 'category' | 'matchMethod' | 'verdict' | 'reason' | 'facts' | 'displayName' | 'variantLabel' | 'nameCategory' | 'attrs'> & {
  verdict: { label: Label; reason: string | null; facts: VerdictFacts | null };
  cheaper: SellerCheaper | null;
};
/** A variant of a seller's listing; label: the shop's variant title, else the clean option (the colour), else null. */
export type VariantView = { id: number; sellerId: number; label: string | null; priceCents: number | null; inStock: boolean | null };
export type ProductPage = {
  key: string;
  product: {
    key: string;
    name: string;
    specs: string | null;
    brand: string | null;
    imageUrl: string | null;
    category: string | null;
    attributes: { key: string; label: string; value: string }[];
  };
  /** in stock (or not known out of stock) first, then cheapest first, no price last */
  sellers: SellerView[];
  /** the first seller with a price that is not known out of stock, null when none */
  cheapestId: number | null;
  variants: VariantView[];
  history: SellerHistoryObs[];
  minHistoryDays: number;
  raiseWindowDays: number;
};

const plainText = (s: string | null): string | null => (s !== null && s.trim() !== '' && s.length <= 120 ? s.trim() : null);

/** The product page answer from a product group and the stored thresholds. */
export function productPage(g: ProductGroup, thresholds: { cheaperPct: number; minHistoryDays: number; raiseWindowDays: number }): ProductPage {
  const order = (s: Seller) => [s.inStock === false ? 1 : 0, positive(s.priceCents) ? s.priceCents : Number.POSITIVE_INFINITY, s.id];
  const sorted = [...g.sellers].sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  const { name, category, attrs } = productName(sorted.map(listingOf), sorted[0].title);
  const brand = typeof attrs.brand === 'string' ? plainText(attrs.brand) : null;
  // every seller of a product page is a trusted member (or the listing alone), so none is "possibly the same"
  const asTarget = sorted.map((s) => ({ ...s, possible: false }));
  const sellers: SellerView[] = sorted.map((s) => {
    const target = cheaperAt(s, asTarget.filter((o) => o.shopSlug !== s.shopSlug), thresholds.cheaperPct);
    return {
      id: s.id,
      productId: s.productId,
      shop: s.shop,
      shopSlug: s.shopSlug,
      title: s.title,
      url: webAddress(s.url),
      priceCents: positive(s.priceCents) ? s.priceCents : null,
      wasCents: positive(s.wasCents) ? s.wasCents : null,
      inStock: s.inStock,
      bf: s.bf,
      verdict: { label: s.verdict, reason: s.reason, facts: s.facts },
      cheaper: target && { id: target.id, shop: target.shop, shopSlug: target.shopSlug, priceCents: target.priceCents as number },
    };
  });
  const byId = new Map(g.sellers.map((s) => [s.id, s]));
  const variantCount = new Map<number, number>();
  for (const v of g.variants) variantCount.set(v.sellerId, (variantCount.get(v.sellerId) ?? 0) + 1);
  const variants: VariantView[] = g.variants.map((v) => {
    const s = byId.get(v.sellerId);
    const own = plainText(v.variantTitle);
    // a listing with one variant: its option is in the clean variant label (the identity specs taken out)
    const clean = !own && s && variantCount.get(v.sellerId) === 1 ? optionLabel(s.variantLabel, s.nameCategory, s.attrs) : null;
    return { id: v.id, sellerId: v.sellerId, label: own ?? clean, priceCents: positive(v.priceCents) ? v.priceCents : null, inStock: v.inStock };
  });
  return {
    key: g.key,
    product: {
      key: g.key,
      name,
      specs: specsSummary(category, attrs, name),
      brand,
      imageUrl: sorted.map((s) => webAddress(s.imageUrl)).find((u) => u !== null) ?? null,
      category: category ?? sorted[0].category,
      attributes: attributeList(category, attrs),
    },
    sellers,
    cheapestId: sellers.find((s) => s.priceCents !== null && s.inStock !== false)?.id ?? null,
    variants,
    history: g.history,
    minHistoryDays: thresholds.minHistoryDays,
    raiseWindowDays: thresholds.raiseWindowDays,
  };
}

/**
 * The cheapest exact match (not `possible`) with a positive price, not known out of stock, at least
 * cheaperPct below the product's price; null when there is none or the product has no price.
 */
export function cheaperAt<T extends { possible: boolean; priceCents: number | null; inStock: boolean | null }>(
  product: { priceCents: number | null },
  others: T[],
  cheaperPct: number,
): T | null {
  const own = product.priceCents;
  if (own === null || own <= 0) return null;
  const limit = own * (1 - cheaperPct / 100);
  let best: T | null = null;
  for (const o of others) {
    if (o.possible || o.priceCents === null || o.priceCents <= 0 || o.inStock === false) continue;
    if (o.priceCents > limit) continue;
    if (!best || o.priceCents < (best.priceCents as number)) best = o;
  }
  return best;
}

/** Optional price bound in whole euros: null when absent, undefined when not an integer 0..100000. */
function euroParam(url: URL, name: string): number | null | undefined {
  const v = url.searchParams.get(name);
  if (v === null) return null;
  if (!/^\d{1,6}$/.test(v)) return undefined;
  const n = Number(v);
  return n <= MAX_EUROS ? n : undefined;
}

async function home(data: Data): Promise<Response> {
  const [settings, good, avoid] = await Promise.all([
    data.settings(),
    data.deals({ verdict: 'good', category: null, shop: null, minCents: null, maxCents: null, limit: HOME_CARDS, offset: 0 }),
    data.deals({ verdict: 'avoid', category: null, shop: null, minCents: null, maxCents: null, limit: HOME_CARDS, offset: 0 }),
  ]);
  return json({ phrases: settings.phrases, good: good.items, avoid: avoid.items, minHistoryDays: settings.thresholds.minHistoryDays });
}

async function search(data: Data, url: URL): Promise<Response> {
  const shop = slugParam(url, 'shop');
  if (shop === undefined) return badRequest('bad shop');
  const pattern = searchPattern(url.searchParams.get('q') ?? '');
  if (!pattern) return json({ results: [] });
  return json({ results: productResults(await data.search(pattern, shop)) });
}

async function productByKey(data: Data, key: string): Promise<Response> {
  const [group, settings] = await Promise.all([data.productGroup(key), data.settings()]);
  if (!group) return json({ error: 'unknown product' }, 404);
  return json(productPage(group, settings.thresholds));
}

async function product(data: Data, id: number): Promise<Response> {
  const [detail, settings] = await Promise.all([data.product(id), data.settings()]);
  if (!detail) return json({ error: 'unknown product' }, 404);
  const { verdict, reason, facts, ...info } = detail.product;
  return json({
    product: info,
    variants: detail.variants,
    history: detail.history,
    verdict: { label: verdict, reason, facts },
    others: detail.others,
    cheaper: cheaperAt(detail.product, detail.others, settings.thresholds.cheaperPct),
    minHistoryDays: settings.thresholds.minHistoryDays,
    raiseWindowDays: settings.thresholds.raiseWindowDays,
  });
}

async function shopPage(data: Data, slug: string): Promise<Response> {
  const found = await data.shop(slug);
  if (!found) return json({ error: 'unknown shop' }, 404);
  const { thresholds } = await data.settings();
  const [avoid, good, changes] = await Promise.all([
    data.deals({ verdict: 'avoid', category: null, shop: slug, minCents: null, maxCents: null, limit: SHOP_CARDS, offset: 0 }),
    data.deals({ verdict: 'good', category: null, shop: slug, minCents: null, maxCents: null, limit: SHOP_CARDS, offset: 0 }),
    // price changes over the stored raise window, which the page names
    data.shopChanges(found.shop.id, thresholds.raiseWindowDays),
  ]);
  const rating = found.rating ?? { ...computeRating({ judged: 0, good: 0, avoid: 0, wasRaised: 0 }, DEFAULT_SETTINGS.thresholds), judged: 0 };
  return json({
    shop: found.shop,
    rating,
    avoid: avoid.items,
    good: good.items,
    rises: changes.rises,
    drops: changes.drops,
    stats: found.stats,
    raiseWindowDays: thresholds.raiseWindowDays,
  });
}

async function categories(data: Data): Promise<Response> {
  const counts = new Map((await data.categories()).map((c) => [c.slug, c]));
  const none = counts.get('');
  return json({
    categories: SITE_CATEGORIES.map((c) => {
      const n = counts.get(c.slug);
      return { slug: c.slug, name: c.name, count: n?.count ?? 0, good: n?.good ?? 0, avoid: n?.avoid ?? 0 };
    }),
    // rows without a category, so totals over the list can cover every deal
    uncategorised: { count: none?.count ?? 0, good: none?.good ?? 0, avoid: none?.avoid ?? 0 },
  });
}

/**
 * Handles /api and /api/*; unknown paths give JSON 404. `access` is the request's access mode (index.ts passes
 * the loaded settings): while the site is private, reads skip the shared cache (cache.ts). Callers without it
 * (tests of the routes) get the public behaviour.
 */
export async function handleApi(req: Request, env: Env, url: URL, deps: ApiDeps, access: AccessSettings = { public: true }): Promise<Response> {
  const p = url.pathname;
  if (p === '/api/reports') return handleReport(req, env, url, deps.reports ?? DEFAULT_REPORTS);
  if (p === '/api/admin' || p.startsWith('/api/admin/')) return handleAdmin(req, env, url, deps.admin ?? DEFAULT_ADMIN);
  const productMatch = /^\/api\/products\/([^/]*)$/.exec(p);
  const productKeyMatch = /^\/api\/product\/([^/]*)$/.exec(p);
  const shopMatch = /^\/api\/shops\/([^/]*)$/.exec(p);
  const known = ['/api/home', '/api/search', '/api/deals', '/api/shops', '/api/categories', '/api/thresholds'].includes(p) || productMatch || productKeyMatch || shopMatch;
  if (!known) return notFound();
  if (req.method === 'HEAD') {
    // same status and headers as GET, no body
    const res = await handleApi(new Request(req.url, { method: 'GET', headers: req.headers }), env, url, deps, access);
    return new Response(null, res);
  }
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });

  const data = () => deps.data(env);
  const cache = deps.cache();
  const cached = (key: string, build: () => Promise<Response>) => cachedResponse(cache, key, build, { private: !access.public });
  const key = (path: string, params: Record<string, string | null> = {}) => {
    const u = new URL(path, url.origin);
    for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
    return u.toString();
  };

  if (p === '/api/search') return search(data(), url);

  if (p === '/api/home') return cached(key(p), () => home(data()));

  if (p === '/api/deals') {
    const type = url.searchParams.get('type') ?? 'good';
    if (type !== 'good' && type !== 'avoid') return badRequest('bad type');
    const pageRaw = url.searchParams.get('page');
    const page = pageRaw === null ? 1 : /^\d{1,5}$/.test(pageRaw) ? Number(pageRaw) : 0;
    if (page < 1 || page > MAX_PAGE) return badRequest('bad page');
    const category = url.searchParams.get('category') || null;
    if (category !== null && !CATEGORY_SLUGS.has(category)) return badRequest('bad category');
    const shop = slugParam(url, 'shop');
    if (shop === undefined) return badRequest('bad shop');
    const min = euroParam(url, 'min');
    const max = euroParam(url, 'max');
    if (min === undefined) return badRequest('bad min');
    if (max === undefined) return badRequest('bad max');
    if (min !== null && max !== null && min > max) return badRequest('bad range');
    const minCents = min === null ? null : min * 100;
    const maxCents = max === null ? null : max * 100;
    const range = { min: min === null ? null : String(min), max: max === null ? null : String(max) };
    return cached(key(p, { type, category, shop, ...range, page: String(page) }), async () => {
      const d = data();
      const [deals, settings] = await Promise.all([
        d.deals({ verdict: type, category, shop, minCents, maxCents, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
        d.settings(),
      ]);
      return json({ ...deals, minHistoryDays: settings.thresholds.minHistoryDays });
    });
  }

  if (p === '/api/shops') return cached(key(p), async () => json({ shops: await data().shops() }));

  if (p === '/api/categories') return cached(key(p), () => categories(data()));

  // the live verdict and rating thresholds, for the How we check page
  if (p === '/api/thresholds') return cached(key(p), async () => json({ thresholds: (await data().settings()).thresholds }));

  if (shopMatch) {
    const slug = shopMatch[1];
    if (!SLUG.test(slug)) return notFound();
    return cached(key(p), () => shopPage(data(), slug));
  }

  if (productKeyMatch) {
    // c<canonical id> (a product sold by matched shops) or s<site_products id> (a listing alone)
    const k = productKeyMatch[1];
    if (!/^[cs]\d{1,15}$/.test(k)) return notFound();
    return cached(key(`/api/product/${k}`), () => productByKey(data(), k));
  }

  if (productMatch) {
    const raw = productMatch[1];
    if (!/^\d{1,15}$/.test(raw)) return notFound();
    const id = Number(raw);
    return cached(key(`/api/products/${id}`), () => product(data(), id));
  }

  return notFound();
}
