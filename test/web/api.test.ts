import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';
import { SITE_CATEGORIES } from '../../src/site/categories.js';
import { type ApiDeps, handleApi, searchPattern } from '../../web/worker/api.js';
import type { ResponseCache } from '../../web/worker/cache.js';
import type { Card, Data, OtherShop, ProductDetail } from '../../web/worker/data.js';
import type { Bindings } from '../../web/worker/index.js';

const env = { DATABASE_URL: 'postgres://ro@example/db' } as Bindings;

function card(id: number, extra: Partial<Card> = {}): Card {
  return {
    id,
    title: `Product ${id}`,
    shop: 'Scan',
    shopSlug: 'scan',
    priceCents: 10000,
    wasCents: null,
    verdict: 'good',
    reason: 'reason',
    bf: true,
    category: 'laptops',
    raisedFrom: null,
    wasRaisedFromCents: null,
    ...extra,
  };
}

function other(id: number, priceCents: number | null, possible: boolean, extra: Partial<OtherShop> = {}): OtherShop {
  return {
    id,
    title: `Other ${id}`,
    shop: `Shop ${id}`,
    shopSlug: `shop-${id}`,
    priceCents,
    inStock: true,
    verdict: 'none',
    matchMethod: possible ? 'title' : 'gtin',
    possible,
    ...extra,
  };
}

function detail(priceCents: number | null, others: OtherShop[]): ProductDetail {
  return {
    product: {
      id: 7,
      productId: 70,
      title: 'Lenovo IdeaPad',
      brand: 'Lenovo',
      url: 'https://shop.example/p/7',
      imageUrl: null,
      category: 'laptops',
      shopId: 1,
      shop: 'Shop',
      shopSlug: 'shop',
      priceCents,
      wasCents: 79900,
      inStock: true,
      bf: true,
      variantCount: 1,
      canonicalId: 3,
      matchMethod: 'gtin',
      matchConfirmed: false,
      verdict: 'avoid',
      reason: 'Price went from €709.00 on 20 Oct to €799.00 on 22 Oct.',
      facts: null,
    },
    variants: [{ id: 70, title: 'Lenovo IdeaPad', variantTitle: null, priceCents, inStock: true }],
    history: [{ productId: 70, at: '2026-10-22T08:00:00.000Z', price: priceCents, was: 79900, inStock: true, bf: true }],
    others,
  };
}

function fakeData(overrides: Partial<Data> = {}): Data {
  return {
    settings: vi.fn(async () => DEFAULT_SETTINGS),
    deals: vi.fn(async (q) => ({ items: Array.from({ length: q.limit }, (_, i) => card(i + 1, { verdict: q.verdict })), total: 100 })),
    search: vi.fn(async () => []),
    shops: vi.fn(async () => [{ slug: 'scan', name: 'Scan', grade: null, products: 3 }]),
    shop: vi.fn(async () => null),
    shopChanges: vi.fn(async () => ({ rises: [], drops: [] })),
    product: vi.fn(async () => null),
    categories: vi.fn(async () => [
      { slug: 'laptops', count: 5, good: 1, avoid: 2 },
      { slug: '', count: 4, good: 3, avoid: 1 },
    ]),
    ...overrides,
  };
}

/** In-memory stand-in for caches.default. */
function memoryCache(): ResponseCache & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return {
    store,
    async match(req) {
      return store.get(req.url)?.clone();
    },
    async put(req, res) {
      store.set(req.url, res.clone());
    },
  };
}

function setup(data: Data = fakeData(), cache: ResponseCache | null = null) {
  const deps: ApiDeps = { data: () => data, cache: () => cache };
  return {
    data,
    fetch: (path: string, init?: RequestInit) => {
      const req = new Request('https://guide.example' + path, init);
      return handleApi(req, env, new URL(req.url), deps);
    },
  };
}

describe('searchPattern', () => {
  it('gives null under 2 characters after trimming', () => {
    expect(searchPattern('a')).toBeNull();
    expect(searchPattern('   a  ')).toBeNull();
    expect(searchPattern('')).toBeNull();
  });

  it('escapes LIKE wildcards and backslashes', () => {
    expect(searchPattern('%%%')).toEqual({ text: '%%%', like: '%\\%\\%\\%%' });
    expect(searchPattern('a_b')).toEqual({ text: 'a_b', like: '%a\\_b%' });
    expect(searchPattern('c:\\x')).toEqual({ text: 'c:\\x', like: '%c:\\\\x%' });
  });

  it('keeps quotes as plain text (queries are parameterised)', () => {
    expect(searchPattern(`o'neill "pro"`)).toEqual({ text: `o'neill "pro"`, like: `%o'neill "pro"%` });
  });

  it('cuts to 120 characters by code point and trims again', () => {
    expect(searchPattern('x'.repeat(500))!.text).toBe('x'.repeat(120));
    expect(searchPattern('x'.repeat(119) + ' y')!.text).toBe('x'.repeat(119));
    const emoji = '\u{1F600}'.repeat(130);
    const t = searchPattern(emoji)!.text;
    expect(Array.from(t)).toHaveLength(120);
    expect(t).toBe('\u{1F600}'.repeat(120));
  });

  it('drops control characters (Postgres rejects NUL in text)', () => {
    expect(searchPattern('ip\u0000hone\u0007')).toEqual({ text: 'iphone', like: '%iphone%' });
    expect(searchPattern('\u0000a\u0000')).toBeNull();
  });
});

describe('GET /api/search', () => {
  it("returns [] for q='a' without calling data", async () => {
    const w = setup();
    const res = await w.fetch('/api/search?q=a');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    expect(w.data.search).not.toHaveBeenCalled();
  });

  it('returns [] for a missing q', async () => {
    const w = setup();
    expect(await (await w.fetch('/api/search')).json()).toEqual({ results: [] });
    expect(w.data.search).not.toHaveBeenCalled();
  });

  it("calls data with an escaped pattern for q='%%%'", async () => {
    const w = setup();
    const res = await w.fetch('/api/search?q=' + encodeURIComponent('%%%'));
    expect(res.status).toBe(200);
    expect(w.data.search).toHaveBeenCalledWith({ text: '%%%', like: '%\\%\\%\\%%' }, null);
  });

  it('answers punctuation-only, quoted and over-long queries with 200', async () => {
    const w = setup();
    for (const q of ['!!', '"\'', `'; drop table shops; --`, '_'.repeat(5), 'y'.repeat(5000)]) {
      const res = await w.fetch('/api/search?q=' + encodeURIComponent(q));
      expect(res.status, q).toBe(200);
      expect(await res.json()).toEqual({ results: [] });
    }
    const long = vi.mocked(w.data.search).mock.calls.at(-1)![0];
    expect(long.text).toHaveLength(120);
  });

  it('passes the shop filter and rejects a malformed shop slug', async () => {
    const w = setup();
    await w.fetch('/api/search?q=ipad&shop=scan');
    expect(w.data.search).toHaveBeenCalledWith({ text: 'ipad', like: '%ipad%' }, 'scan');
    expect((await w.fetch('/api/search?q=ipad&shop=' + encodeURIComponent('Scan%'))).status).toBe(400);
  });

  it('groups hits by canonical id in data order, cheapest first inside a group, max 40 groups', async () => {
    const c5 = { groupKey: 'c5', groupTitle: 'Product 1', canonicalId: 5, inStock: true };
    const hits = [
      { ...card(1, { priceCents: 900 }), ...c5, possible: false },
      { ...card(2, { priceCents: 700 }), ...c5, possible: false },
      { ...card(3, { priceCents: null }), groupKey: 's3', groupTitle: 'Product 3', canonicalId: null, possible: false, inStock: true },
      { ...card(4, { priceCents: 800 }), ...c5, possible: true },
      ...Array.from({ length: 45 }, (_, i) => ({ ...card(100 + i), groupKey: `s${100 + i}`, groupTitle: `Product ${100 + i}`, canonicalId: null, possible: false, inStock: true })),
    ];
    const w = setup(fakeData({ search: vi.fn(async () => hits) }));
    const body = (await (await w.fetch('/api/search?q=lenovo')).json()) as { results: { canonicalId: number | null; title: string; items: Card[] }[] };
    expect(body.results).toHaveLength(40);
    expect(body.results[0].canonicalId).toBe(5);
    expect(body.results[0].items.map((c) => c.id)).toEqual([2, 4, 1]);
    // named after the best hit (the data's groupTitle), not the cheapest member
    expect(body.results[0].title).toBe('Product 1');
    expect(body.results[1]).toMatchObject({ canonicalId: null, items: [{ id: 3, priceCents: null }] });
    expect(body.results[0].items[1]).toMatchObject({ possible: true });
    expect(body.results[0].items[0]).not.toHaveProperty('groupKey');
  });

  it('marks each exact, priced row with the cheapest exact, in-stock row at another shop at least cheaperPct cheaper', async () => {
    const hit = (id: number, shopSlug: string, priceCents: number | null, possible: boolean, inStock: boolean | null = true) => ({
      ...card(id, { shop: shopSlug.toUpperCase(), shopSlug, priceCents }),
      groupKey: 'c5',
      groupTitle: 'Product 1',
      canonicalId: 5,
      possible,
      inStock,
    });
    const hits = [
      hit(1, 'a', 10000, false),
      hit(2, 'b', 9700, false), // 3% cheaper than a, at least cheaperPct 3: counts
      hit(3, 'c', 5000, true), // title-only: never a cheaper target, never gets one
      hit(4, 'd', 6000, false, false), // out of stock: never a cheaper target
      hit(5, 'e', 9800, false), // 2% cheaper than a: below cheaperPct 3
      hit(6, 'b', 9750, false), // same shop as 2: only another shop counts
      hit(7, 'f', null, false),
    ];
    const settings = { ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_SETTINGS.thresholds, cheaperPct: 3 } };
    const w = setup(fakeData({ search: vi.fn(async () => hits), settings: vi.fn(async () => settings) }));
    const body = (await (await w.fetch('/api/search?q=lenovo')).json()) as {
      results: { items: { id: number; cheaper: { id: number; shop: string; shopSlug: string; priceCents: number } | null }[] }[];
    };
    const cheaper = Object.fromEntries(body.results[0].items.map((i) => [i.id, i.cheaper?.id ?? null]));
    expect(cheaper).toEqual({ 1: 2, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null });
    expect(body.results[0].items.find((i) => i.id === 1)!.cheaper).toEqual({ id: 2, shop: 'B', shopSlug: 'b', priceCents: 9700 });
  });

  it('is never cached', async () => {
    const cache = memoryCache();
    const w = setup(fakeData(), cache);
    const res = await w.fetch('/api/search?q=ipad');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(cache.store.size).toBe(0);
  });
});

describe('GET /api/deals', () => {
  it('returns 400 for an unknown type', async () => {
    const w = setup();
    const res = await w.fetch('/api/deals?type=other');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad type' });
    expect(w.data.deals).not.toHaveBeenCalled();
  });

  it('returns 400 for a page that is not an integer of at least 1', async () => {
    const w = setup();
    for (const page of ['0', '-1', '1.5', 'abc', '', '1e3', '99999999999']) {
      expect((await w.fetch('/api/deals?page=' + page)).status, page).toBe(400);
    }
    expect(w.data.deals).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown category slug', async () => {
    const w = setup();
    expect((await w.fetch('/api/deals?category=cars')).status).toBe(400);
    expect(w.data.deals).not.toHaveBeenCalled();
  });

  it('pages 24 at a time with the filters passed through', async () => {
    const w = setup();
    const res = await w.fetch('/api/deals?type=avoid&category=laptops&shop=scan&page=3');
    expect(res.status).toBe(200);
    expect(w.data.deals).toHaveBeenCalledWith({ verdict: 'avoid', category: 'laptops', shop: 'scan', minCents: null, maxCents: null, limit: 24, offset: 48 });
    const body = (await res.json()) as { items: Card[]; total: number };
    expect(body.items).toHaveLength(24);
    expect(body.total).toBe(100);
  });

  it('returns 400 for a price range that is not whole euros 0..100000, or has min above max', async () => {
    const w = setup();
    const bad = ['min=-1', 'min=1.5', 'min=abc', 'min=', 'min=1e3', 'min=100001', 'max=100001', 'max=-5', 'max=2.0', 'max=', 'min=500&max=499', 'min=99999999999'];
    for (const q of bad) expect((await w.fetch('/api/deals?' + q)).status, q).toBe(400);
    expect(w.data.deals).not.toHaveBeenCalled();
  });

  it('passes a price range in cents, accepts the limits and min equal to max', async () => {
    const w = setup();
    expect((await w.fetch('/api/deals?min=100&max=500')).status).toBe(200);
    expect(w.data.deals).toHaveBeenLastCalledWith({ verdict: 'good', category: null, shop: null, minCents: 10000, maxCents: 50000, limit: 24, offset: 0 });
    expect((await w.fetch('/api/deals?min=0&max=100000')).status).toBe(200);
    expect(w.data.deals).toHaveBeenLastCalledWith(expect.objectContaining({ minCents: 0, maxCents: 10_000_000 }));
    expect((await w.fetch('/api/deals?min=250&max=250')).status).toBe(200);
    expect((await w.fetch('/api/deals?min=300')).status).toBe(200);
    expect(w.data.deals).toHaveBeenLastCalledWith(expect.objectContaining({ minCents: 30000, maxCents: null }));
    expect((await w.fetch('/api/deals?max=300')).status).toBe(200);
    expect(w.data.deals).toHaveBeenLastCalledWith(expect.objectContaining({ minCents: null, maxCents: 30000 }));
  });

  it('keys the cache on the validated range, so the same range is one entry and another range is not', async () => {
    const cache = memoryCache();
    const w = setup(fakeData(), cache);
    await w.fetch('/api/deals?min=100&max=500');
    await w.fetch('/api/deals?max=500&min=0100&junk=1');
    expect(w.data.deals).toHaveBeenCalledTimes(1);
    await w.fetch('/api/deals?min=100&max=600');
    await w.fetch('/api/deals');
    expect(w.data.deals).toHaveBeenCalledTimes(3);
  });

  it('defaults to good deals, page 1', async () => {
    const w = setup();
    await w.fetch('/api/deals');
    expect(w.data.deals).toHaveBeenCalledWith({ verdict: 'good', category: null, shop: null, minCents: null, maxCents: null, limit: 24, offset: 0 });
  });

  it('serialises a null price as null, never 0', async () => {
    const w = setup(fakeData({ deals: vi.fn(async () => ({ items: [card(1, { verdict: 'avoid', priceCents: null, wasCents: null })], total: 1 })) }));
    const body = (await (await w.fetch('/api/deals?type=avoid')).json()) as { items: Card[] };
    expect(body.items[0].priceCents).toBeNull();
    expect(body.items[0].wasCents).toBeNull();
  });
});

describe('GET /api/home', () => {
  it('returns the phrases and 6 good and 6 avoid cards', async () => {
    const w = setup();
    const res = await w.fetch('/api/home');
    const body = (await res.json()) as { phrases: Record<string, string[]>; good: Card[]; avoid: Card[] };
    expect(body.phrases).toEqual(DEFAULT_SETTINGS.phrases);
    expect(body.good).toHaveLength(6);
    expect(body.avoid).toHaveLength(6);
    expect(body.avoid[0].verdict).toBe('avoid');
    expect(w.data.deals).toHaveBeenCalledWith({ verdict: 'good', category: null, shop: null, minCents: null, maxCents: null, limit: 6, offset: 0 });
  });

  it('home and deals carry minHistoryDays from the stored thresholds', async () => {
    const settings = { ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_SETTINGS.thresholds, minHistoryDays: 21 } };
    const w = setup(fakeData({ settings: vi.fn(async () => settings) }));
    expect(((await (await w.fetch('/api/home')).json()) as { minHistoryDays: number }).minHistoryDays).toBe(21);
    expect(((await (await w.fetch('/api/deals?type=good')).json()) as { minHistoryDays: number }).minHistoryDays).toBe(21);
  });

  it('the product page carries minHistoryDays and raiseWindowDays from the stored thresholds', async () => {
    const settings = { ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_SETTINGS.thresholds, minHistoryDays: 21, raiseWindowDays: 9 } };
    const w = setup(fakeData({ settings: vi.fn(async () => settings), product: vi.fn(async () => detail(79900, [])) }));
    const body = (await (await w.fetch('/api/products/7')).json()) as { minHistoryDays: number; raiseWindowDays: number };
    expect(body.minHistoryDays).toBe(21);
    expect(body.raiseWindowDays).toBe(9);
  });
});

describe('GET /api/thresholds', () => {
  it('returns the stored thresholds, public for 10 minutes', async () => {
    const settings = { ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_SETTINGS.thresholds, raisePct: 4, minJudgedForRating: 30 } };
    const w = setup(fakeData({ settings: vi.fn(async () => settings) }));
    const res = await w.fetch('/api/thresholds');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=600');
    expect(await res.json()).toEqual({ thresholds: settings.thresholds });
  });

  it('gives the defaults when nothing is stored, and carries nothing but the thresholds', async () => {
    const w = setup();
    expect(await (await w.fetch('/api/thresholds')).json()).toEqual({ thresholds: DEFAULT_SETTINGS.thresholds });
  });

  it('is served from the cache on a repeat and answers HEAD without a body', async () => {
    const cache = memoryCache();
    const w = setup(fakeData(), cache);
    await w.fetch('/api/thresholds');
    await w.fetch('/api/thresholds');
    expect(w.data.settings).toHaveBeenCalledTimes(1);
    const head = await w.fetch('/api/thresholds', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});

describe('GET /api/products/:id', () => {
  it('returns 404 JSON for an unknown or non-numeric id', async () => {
    const w = setup();
    for (const path of ['/api/products/999', '/api/products/abc', '/api/products/1.5', '/api/products/', '/api/products/' + '9'.repeat(30)]) {
      const res = await w.fetch(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(w.data.product).toHaveBeenCalledTimes(1);
    expect(w.data.product).toHaveBeenCalledWith(999);
  });

  it('gives cheaper null when the only cheaper match is title-only', async () => {
    const w = setup(fakeData({ product: vi.fn(async () => detail(79900, [other(1, 50000, true), other(2, 90000, false)])) }));
    const body = (await (await w.fetch('/api/products/7')).json()) as { cheaper: OtherShop | null; others: OtherShop[] };
    expect(body.cheaper).toBeNull();
    expect(body.others.map((o) => [o.id, o.possible])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('gives the cheapest exact match that is at least cheaperPct cheaper', async () => {
    const others = [other(1, 78400, false), other(2, 70000, false), other(3, 60000, false, { inStock: false }), other(4, 50000, true), other(5, null, false)];
    const w = setup(fakeData({ product: vi.fn(async () => detail(79900, others)) }));
    const body = (await (await w.fetch('/api/products/7')).json()) as { cheaper: OtherShop | null };
    expect(body.cheaper?.id).toBe(2);
  });

  it('needs at least cheaperPct (2%) difference', async () => {
    // 79900 * 0.98 = 78302: 78400 is only 1.9% cheaper
    const w = setup(fakeData({ product: vi.fn(async () => detail(79900, [other(1, 78400, false)])) }));
    expect(((await (await w.fetch('/api/products/7')).json()) as { cheaper: unknown }).cheaper).toBeNull();
    const w2 = setup(fakeData({ product: vi.fn(async () => detail(79900, [other(1, 78302, false)])) }));
    expect(((await (await w2.fetch('/api/products/7')).json()) as { cheaper: OtherShop }).cheaper.id).toBe(1);
  });

  it('uses the stored cheaperPct', async () => {
    const settings = { ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_SETTINGS.thresholds, cheaperPct: 20 } };
    const w = setup(fakeData({ settings: vi.fn(async () => settings), product: vi.fn(async () => detail(79900, [other(1, 70000, false)])) }));
    expect(((await (await w.fetch('/api/products/7')).json()) as { cheaper: unknown }).cheaper).toBeNull();
  });

  it('gives cheaper null when the product has no price', async () => {
    const w = setup(fakeData({ product: vi.fn(async () => detail(null, [other(1, 100, false)])) }));
    const body = (await (await w.fetch('/api/products/7')).json()) as { cheaper: unknown; product: { priceCents: unknown } };
    expect(body.cheaper).toBeNull();
    expect(body.product.priceCents).toBeNull();
  });

  it('returns product (with productId for reports), variants, history, verdict', async () => {
    const w = setup(fakeData({ product: vi.fn(async () => detail(79900, [])) }));
    const body = (await (await w.fetch('/api/products/7')).json()) as Record<string, unknown>;
    expect(body.product).toMatchObject({ id: 7, productId: 70, shopSlug: 'shop', bf: true });
    expect(body.product).not.toHaveProperty('verdict');
    expect(body.verdict).toEqual({ label: 'avoid', reason: 'Price went from €709.00 on 20 Oct to €799.00 on 22 Oct.', facts: null });
    expect(body.variants).toHaveLength(1);
    expect(body.history).toEqual([{ productId: 70, at: '2026-10-22T08:00:00.000Z', price: 79900, was: 79900, inStock: true, bf: true }]);
    expect(body.cheaper).toBeNull();
  });
});

describe('GET /api/shops and /api/shops/:slug', () => {
  it('lists shops', async () => {
    const w = setup();
    expect(await (await w.fetch('/api/shops')).json()).toEqual({ shops: [{ slug: 'scan', name: 'Scan', grade: null, products: 3 }] });
  });

  it('returns 404 for an unknown or malformed slug', async () => {
    const w = setup();
    expect((await w.fetch('/api/shops/nope')).status).toBe(404);
    expect((await w.fetch('/api/shops/Bad_Slug')).status).toBe(404);
    expect(w.data.shop).toHaveBeenCalledTimes(1);
  });

  it('shows "Not rated yet" without a rating row and 5 cards each', async () => {
    const stats = { products: 3, judged: 0, good: 0, avoid: 0, wasRaised: 0, bfMarked: 1, realDealPct: null };
    const shop = { id: 9, slug: 'scan', name: 'Scan', url: 'https://scan.example', category: 'electronics' };
    const rises = [{ id: 1, title: 'T', fromCents: 100, toCents: 120, pct: 20, fromAt: '2026-10-20T00:00:00.000Z', at: '2026-10-22T00:00:00.000Z' }];
    const w = setup(fakeData({ shop: vi.fn(async () => ({ shop, rating: null, stats })), shopChanges: vi.fn(async () => ({ rises, drops: [] })) }));
    const res = await w.fetch('/api/shops/scan');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { good: Card[]; avoid: Card[] };
    expect(body.shop).toEqual(shop);
    expect(body.rating).toEqual({ grade: null, sentence: 'Not rated yet: not enough Black Friday deals checked.', judged: 0 });
    expect(body.stats).toEqual(stats);
    expect(body.rises).toEqual(rises);
    expect(body.drops).toEqual([]);
    expect(body.good).toHaveLength(5);
    expect(body.avoid).toHaveLength(5);
    expect(w.data.deals).toHaveBeenCalledWith({ verdict: 'avoid', category: null, shop: 'scan', minCents: null, maxCents: null, limit: 5, offset: 0 });
    expect(w.data.shopChanges).toHaveBeenCalledWith(9);
  });
});

describe('GET /api/categories', () => {
  it('lists every site category in order with counts (0 when absent)', async () => {
    const w = setup();
    const body = (await (await w.fetch('/api/categories')).json()) as { categories: { slug: string; name: string; count: number }[] };
    expect(body.categories.map((c) => c.slug)).toEqual(SITE_CATEGORIES.map((c) => c.slug));
    expect(body.categories[0]).toEqual({ slug: 'laptops', name: 'Laptops', count: 5, good: 1, avoid: 2 });
    expect(body.categories[1]).toEqual({ slug: 'phones', name: 'Phones & tablets', count: 0, good: 0, avoid: 0 });
  });

  it('adds the rows without a category as `uncategorised`, so totals can cover every deal', async () => {
    const w = setup();
    const body = (await (await w.fetch('/api/categories')).json()) as { categories: { slug: string }[]; uncategorised: unknown };
    expect(body.uncategorised).toEqual({ count: 4, good: 3, avoid: 1 });
    expect(body.categories.some((c) => c.slug === '')).toBe(false);
  });

  it('has an all-zero `uncategorised` when every row has a category', async () => {
    const w = setup(fakeData({ categories: vi.fn(async () => [{ slug: 'laptops', count: 5, good: 1, avoid: 2 }]) }));
    const body = (await (await w.fetch('/api/categories')).json()) as { uncategorised: unknown };
    expect(body.uncategorised).toEqual({ count: 0, good: 0, avoid: 0 });
  });
});

describe('routing and caching', () => {
  it('returns JSON 404 for an unknown API path and 405 for a non-GET read', async () => {
    const w = setup();
    const res = await w.fetch('/api/nothing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    const post = await w.fetch('/api/home', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('answers HEAD like GET without a body', async () => {
    const cache = memoryCache();
    const w = setup(fakeData(), cache);
    const res = await w.fetch('/api/home', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=600');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).toBe('');
    // the cached GET body is intact
    const get = (await (await w.fetch('/api/home')).json()) as { good: Card[] };
    expect(get.good).toHaveLength(6);
    expect(w.data.settings).toHaveBeenCalledTimes(1);

    const search = await w.fetch('/api/search?q=ipad', { method: 'HEAD' });
    expect(search.status).toBe(200);
    expect(search.headers.get('cache-control')).toBe('no-store');
    expect(await search.text()).toBe('');
    expect((await w.fetch('/api/products/999', { method: 'HEAD' })).status).toBe(404);
  });

  it('marks every read except search public for 10 minutes', async () => {
    const product = vi.fn(async () => detail(79900, []));
    const shop = vi.fn(async () => ({
      shop: { id: 9, slug: 'scan', name: 'Scan', url: 'https://scan.example', category: null },
      rating: null,
      stats: { products: 0, judged: 0, good: 0, avoid: 0, wasRaised: 0, bfMarked: 0, realDealPct: null },
    }));
    const w = setup(fakeData({ product, shop }));
    for (const path of ['/api/home', '/api/deals?type=good', '/api/shops', '/api/shops/scan', '/api/products/7', '/api/categories']) {
      const res = await w.fetch(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('public, max-age=600');
    }
  });

  it('serves a repeat from the cache without touching data, keyed on validated params only', async () => {
    const cache = memoryCache();
    const w = setup(fakeData(), cache);
    const first = await w.fetch('/api/deals?type=avoid&page=2');
    const second = await w.fetch('/api/deals?page=2&type=avoid&junk=1');
    expect(w.data.deals).toHaveBeenCalledTimes(1);
    expect(second.headers.get('cache-control')).toBe('public, max-age=600');
    expect(await second.json()).toEqual(await first.json());
  });

  it('does not cache errors and still answers when the cache throws', async () => {
    const cache = memoryCache();
    const w = setup(fakeData(), cache);
    await w.fetch('/api/products/5');
    expect(cache.store.size).toBe(0);

    const broken: ResponseCache = {
      match: async () => {
        throw new Error('cache down');
      },
      put: async () => {
        throw new Error('cache down');
      },
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w2 = setup(fakeData(), broken);
    const res = await w2.fetch('/api/shops');
    expect(res.status).toBe(200);
    spy.mockRestore();
  });
});
