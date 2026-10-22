// Read API router. Access control already ran (index.ts); this validates parameters, calls Data and caches.
// Every read except search is cached for 10 minutes (cache.ts); errors propagate to the handler's generic 500.
import { SITE_CATEGORIES } from '../../src/site/categories.js';
import { computeRating } from '../../src/site/rating.js';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';
import { type ResponseCache, cached } from './cache.js';
import type { Card, Data, GroupItem, GroupResult, SearchHit, SearchPattern } from './data.js';
import type { Env } from './env.js';
import { json } from './http.js';

export interface ApiDeps {
  data: (env: Env) => Data;
  cache: () => ResponseCache | null;
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
 * Hits grouped in data order (best group first), cheapest first inside a group (no price last).
 * Each row gets `cheaper`: cheaperAt over the group's rows at other shops (Ruling R36), so a row
 * that is only "possibly the same", a title-only target and an out-of-stock target never count.
 */
export function groupResults(hits: SearchHit[], cheaperPct: number): GroupResult[] {
  const groups = new Map<string, { canonicalId: number | null; items: Omit<GroupItem, 'cheaper'>[] }>();
  for (const { groupKey, canonicalId, ...item } of hits) {
    let g = groups.get(groupKey);
    if (!g) {
      if (groups.size >= SEARCH_GROUPS) continue;
      g = { canonicalId, items: [] };
      groups.set(groupKey, g);
    }
    g.items.push(item);
  }
  const price = (c: Card) => (c.priceCents !== null && c.priceCents > 0 ? c.priceCents : Number.POSITIVE_INFINITY);
  return [...groups.values()].map((g) => {
    const sorted = [...g.items].sort((a, b) => price(a) - price(b) || a.id - b.id);
    const items: GroupItem[] = sorted.map((item) => {
      const target = item.possible ? null : cheaperAt(item, sorted.filter((o) => o.shopSlug !== item.shopSlug), cheaperPct);
      return { ...item, cheaper: target && { id: target.id, shop: target.shop, shopSlug: target.shopSlug, priceCents: target.priceCents as number } };
    });
    return { canonicalId: g.canonicalId, title: items[0].title, items };
  });
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
  const [hits, settings] = await Promise.all([data.search(pattern, shop), data.settings()]);
  return json({ results: groupResults(hits, settings.thresholds.cheaperPct) });
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
  });
}

async function shopPage(data: Data, slug: string): Promise<Response> {
  const found = await data.shop(slug);
  if (!found) return json({ error: 'unknown shop' }, 404);
  const [avoid, good, changes] = await Promise.all([
    data.deals({ verdict: 'avoid', category: null, shop: slug, minCents: null, maxCents: null, limit: SHOP_CARDS, offset: 0 }),
    data.deals({ verdict: 'good', category: null, shop: slug, minCents: null, maxCents: null, limit: SHOP_CARDS, offset: 0 }),
    data.shopChanges(found.shop.id),
  ]);
  const rating = found.rating ?? { ...computeRating({ judged: 0, good: 0, avoid: 0, wasRaised: 0 }, DEFAULT_SETTINGS.thresholds), judged: 0 };
  return json({ shop: found.shop, rating, avoid: avoid.items, good: good.items, rises: changes.rises, drops: changes.drops, stats: found.stats });
}

async function categories(data: Data): Promise<Response> {
  const counts = new Map((await data.categories()).map((c) => [c.slug, c]));
  return json({
    categories: SITE_CATEGORIES.map((c) => {
      const n = counts.get(c.slug);
      return { slug: c.slug, name: c.name, count: n?.count ?? 0, good: n?.good ?? 0, avoid: n?.avoid ?? 0 };
    }),
  });
}

/** Handles /api and /api/*; unknown paths give JSON 404. */
export async function handleApi(req: Request, env: Env, url: URL, deps: ApiDeps): Promise<Response> {
  const p = url.pathname;
  const productMatch = /^\/api\/products\/([^/]*)$/.exec(p);
  const shopMatch = /^\/api\/shops\/([^/]*)$/.exec(p);
  const known = ['/api/home', '/api/search', '/api/deals', '/api/shops', '/api/categories'].includes(p) || productMatch || shopMatch;
  if (!known) return notFound();
  if (req.method === 'HEAD') {
    // same status and headers as GET, no body
    const res = await handleApi(new Request(req.url, { method: 'GET', headers: req.headers }), env, url, deps);
    return new Response(null, res);
  }
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });

  const data = () => deps.data(env);
  const cache = deps.cache();
  const key = (path: string, params: Record<string, string | null> = {}) => {
    const u = new URL(path, url.origin);
    for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
    return u.toString();
  };

  if (p === '/api/search') return search(data(), url);

  if (p === '/api/home') return cached(cache, key(p), () => home(data()));

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
    return cached(cache, key(p, { type, category, shop, ...range, page: String(page) }), async () => {
      const d = data();
      const [deals, settings] = await Promise.all([
        d.deals({ verdict: type, category, shop, minCents, maxCents, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
        d.settings(),
      ]);
      return json({ ...deals, minHistoryDays: settings.thresholds.minHistoryDays });
    });
  }

  if (p === '/api/shops') return cached(cache, key(p), async () => json({ shops: await data().shops() }));

  if (p === '/api/categories') return cached(cache, key(p), () => categories(data()));

  if (shopMatch) {
    const slug = shopMatch[1];
    if (!SLUG.test(slug)) return notFound();
    return cached(cache, key(p), () => shopPage(data(), slug));
  }

  if (productMatch) {
    const raw = productMatch[1];
    if (!/^\d{1,15}$/.test(raw)) return notFound();
    const id = Number(raw);
    return cached(cache, key(`/api/products/${id}`), () => product(data(), id));
  }

  return notFound();
}
