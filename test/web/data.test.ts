// The read API's SQL (web/worker/data.ts) against an in-process PGlite with the real migrations.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';
import { createData, type Data, type SqlRunner } from '../../web/worker/data.js';

let pg: PGlite;
let data: Data;

function runner(db: PGlite): SqlRunner {
  return {
    query: async (text, params) => (await db.query<Record<string, unknown>>(text, params)).rows,
    transaction: (statements) =>
      db.transaction(async (tx) => {
        const out: Record<string, unknown>[][] = [];
        for (const s of statements) out.push((await tx.query<Record<string, unknown>>(s.text, s.params)).rows);
        return out;
      }),
  };
}

const goodFacts = (realPct: number) => JSON.stringify({ low30: 80000, usual: 80000, claimedPct: 20, realPct, historyDays: 20, priceChanges: 1, wasChanges: 0, daysWorthBuying: 1 });
const avoidFacts = (from: number, to: number, wasRaisedFrom?: number) =>
  JSON.stringify({ low30: from, usual: from, claimedPct: 10, realPct: 5, historyDays: 20, priceChanges: 1, wasChanges: 0, daysWorthBuying: 0, raisedFrom: { price: from, at: '2026-10-10' }, raisedTo: { price: to, at: '2026-10-20' }, wasRaisedFrom });

beforeAll(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  pg = await PGlite.create({ dataDir: 'memory://', extensions: { pg_trgm } });
  const dir = path.resolve('db/migrations');
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(await readFile(path.join(dir, f), 'utf8'));

  await pg.exec(`
    insert into shops (id, slug, name, base_url, adapter, active, site_hidden, category) values
      (1, 'alpha', 'Alpha', 'https://alpha.example', 'woo', true, false, 'electronics'),
      (2, 'beta', 'Beta', 'https://beta.example', 'woo', true, false, null),
      (3, 'hidden', 'Hidden', 'https://hidden.example', 'woo', true, true, null),
      (4, 'gone', 'Gone', 'https://gone.example', 'woo', false, false, null);

    insert into products (id, shop_id, external_id, parent_external_id, title, variant_title, bf_status) values
      (10, 1, 'v1', 'G1', 'Lenovo IdeaPad Slim 5', '16GB', 'marked'),
      (11, 1, 'v2', 'G1', 'Lenovo IdeaPad Slim 5', '32GB', null),
      (12, 1, 'other', null, 'Other thing', null, null),
      (20, 1, 'p7', null, 'Samsung Galaxy Tab', null, null),
      (30, 2, 'z1', null, 'Zero priced thing', null, null);

    insert into price_observations (product_id, observed_at, price_cents, was_price_cents, in_stock, bf_marked) values
      (10, now() - interval '70 days', 90000, null, true, null),
      (10, now() - interval '3 days', 80000, null, true, null),
      (10, now() - interval '1 day', 70000, 90000, true, true),
      (11, now() - interval '2 days', 95000, null, false, null),
      (20, now() - interval '5 days', 40000, null, true, null),
      (20, now() - interval '1 day', 48000, null, true, null),
      (30, now() - interval '1 day', 0, 0, true, null);

    insert into shop_ratings (shop_id, grade, judged, good, avoid, was_raised, sentence) values
      (1, 'B', 30, 25, 3, 1, 'Mostly honest. A few deals need a closer look.');

    insert into site_settings (key, value) values
      ('phrases', '{"morning": ["Stored *morning*."]}'),
      ('thresholds', '{"cheaperPct": 4}');

    insert into site_products (id, shop_id, group_key, title, category, rep_product_id, price_cents, was_price_cents, in_stock,
        bf_status, verdict, reason, facts, canonical_id, match_method, match_confirmed, updated_at) values
      (1, 1, 'G1', 'Lenovo IdeaPad Slim 5', 'laptops', 10, 70000, 90000, true, 'marked', 'good', 'r1', '${goodFacts(-12.5)}', 100, 'gtin', false, now()),
      (2, 2, 'B1', 'Lenovo IdeaPad Slim 5 Laptop', 'laptops', null, 60000, null, true, null, 'none', null, null, 100, 'gtin', false, now()),
      (3, 1, 'G3', 'Null price good', 'laptops', null, null, null, null, 'marked', 'good', 'r3', '${goodFacts(-30)}', null, null, false, now()),
      (4, 3, 'H1', 'Lenovo IdeaPad hidden shop', 'laptops', null, 50000, null, true, null, 'good', 'r4', '${goodFacts(-40)}', 100, 'gtin', false, now()),
      (5, 4, 'X1', 'Lenovo IdeaPad inactive shop', 'laptops', null, 50000, null, true, null, 'good', 'r5', '${goodFacts(-40)}', 100, 'gtin', false, now()),
      (6, 1, 'S1', 'Lenovo IdeaPad stale row', 'laptops', null, 50000, null, true, null, 'good', 'r6', '${goodFacts(-40)}', 100, 'gtin', false, now() - interval '3 days'),
      (7, 1, 'p7', 'Samsung Galaxy Tab', 'phones', 20, 48000, 50000, true, 'marked', 'avoid', 'r7', '${avoidFacts(40000, 48000)}', null, null, false, now()),
      (8, 2, 'B8', 'Beta avoid no price', 'phones', null, null, null, false, null, 'avoid', 'r8', '${avoidFacts(100, 110, 90)}', null, null, false, now()),
      (9, 2, 'B9', 'Beta good big drop', 'laptops', null, 30000, 50000, true, 'marked', 'good', 'r9', '${goodFacts(-25)}', null, null, false, now()),
      (10, 2, 'B10', 'Lenovo IdeaPad Slim 5 lookalike', 'laptops', null, 40000, null, true, null, 'none', null, null, 200, 'title', false, now()),
      (11, 1, 'other', 'Lenovo IdeaPad Slim 5 lookalike too', 'laptops', 12, 45000, null, true, null, 'none', null, null, 200, 'title', false, now()),
      (12, 2, 'z1', 'Zero priced thing', null, 30, 0, 0, true, null, 'avoid', 'r12', null, null, null, false, now());
  `);
  data = createData(runner(pg));
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('data.ts on PGlite', () => {
  it('settings merge stored rows over the defaults', async () => {
    const s = await data.settings();
    expect(s.phrases.morning).toEqual(['Stored *morning*.']);
    expect(s.phrases.late).toEqual(DEFAULT_SETTINGS.phrases.late);
    expect(s.thresholds.cheaperPct).toBe(4);
  });

  it('good deals: visible, fresh, priced only, biggest real drop first', async () => {
    const r = await data.deals({ verdict: 'good', category: null, shop: null, minCents: null, maxCents: null, limit: 24, offset: 0 });
    expect(r.items.map((c) => c.id)).toEqual([9, 1]);
    expect(r.total).toBe(2);
    expect(r.items[1]).toEqual({
      id: 1,
      title: 'Lenovo IdeaPad Slim 5',
      shop: 'Alpha',
      shopSlug: 'alpha',
      priceCents: 70000,
      wasCents: 90000,
      verdict: 'good',
      reason: 'r1',
      bf: true,
      category: 'laptops',
      raisedFrom: null,
      wasRaisedFromCents: null,
      logoUrl: null,
      logoAspect: null,
    });
  });

  it('avoid deals keep null prices as null, largest rise first', async () => {
    const r = await data.deals({ verdict: 'avoid', category: null, shop: null, minCents: null, maxCents: null, limit: 24, offset: 0 });
    expect(r.items.map((c) => c.id)).toEqual([7, 8, 12]);
    // the price before the raise, from the stored facts (shown on the avoid tag)
    expect(r.items[0].raisedFrom).toEqual({ priceCents: 40000, at: '2026-10-10' });
    expect(r.items[0].wasRaisedFromCents).toBeNull();
    expect(r.items[1].wasRaisedFromCents).toBe(90);
    // no facts stored: no raise facts
    expect(r.items[2].raisedFrom).toBeNull();
    expect(r.items[1].priceCents).toBeNull();
    expect(r.items[1].wasCents).toBeNull();
    // a stored 0 is no price either
    expect(r.items[2].priceCents).toBeNull();
    expect(r.items[2].wasCents).toBeNull();
  });

  it('filters by category and shop, and reports the total past the last page', async () => {
    expect((await data.deals({ verdict: 'good', category: 'laptops', shop: 'alpha', minCents: null, maxCents: null, limit: 24, offset: 0 })).items.map((c) => c.id)).toEqual([1]);
    expect((await data.deals({ verdict: 'good', category: 'phones', shop: null, minCents: null, maxCents: null, limit: 24, offset: 0 })).items).toEqual([]);
    expect(await data.deals({ verdict: 'good', category: null, shop: null, minCents: null, maxCents: null, limit: 24, offset: 48 })).toEqual({ items: [], total: 2 });
    expect((await data.deals({ verdict: 'good', category: null, shop: 'hidden', minCents: null, maxCents: null, limit: 24, offset: 0 })).total).toBe(0);
  });

  it('filters by price range in cents (inclusive) and excludes rows with no price when a range is set', async () => {
    const ids = async (v: 'good' | 'avoid', minCents: number | null, maxCents: number | null) =>
      (await data.deals({ verdict: v, category: null, shop: null, minCents, maxCents, limit: 24, offset: 0 })).items.map((c) => c.id);
    expect(await ids('good', 30000, 70000)).toEqual([9, 1]);
    expect(await ids('good', 30001, 70000)).toEqual([1]);
    expect(await ids('good', null, 30000)).toEqual([9]);
    expect(await ids('good', 70001, null)).toEqual([]);
    // avoid: the rows with no price (8, and 12 stored as 0) only come back without a range
    expect(await ids('avoid', null, null)).toEqual([7, 8, 12]);
    expect(await ids('avoid', 0, null)).toEqual([7]);
    expect(await ids('avoid', null, 100000)).toEqual([7]);
    expect(await ids('avoid', 48001, null)).toEqual([]);
    // total follows the range, not just the page
    const r = await data.deals({ verdict: 'good', category: null, shop: null, minCents: 0, maxCents: 30000, limit: 24, offset: 0 });
    expect(r.total).toBe(1);
  });

  it('search groups canonical members, skips hidden, inactive and stale rows', async () => {
    const hits = await data.search({ text: 'lenovo ideapad', like: '%lenovo ideapad%' }, null);
    const ids = hits.map((h) => h.id);
    expect(ids).not.toContain(4);
    expect(ids).not.toContain(5);
    expect(ids).not.toContain(6);
    const g100 = hits.filter((h) => h.groupKey === 'c100');
    expect(g100.map((h) => h.id).sort()).toEqual([1, 2]);
    expect(g100.every((h) => !h.possible)).toBe(true);
    // title-only matches (not confirmed) are never grouped: each is its own result, and not "possibly the same"
    expect(hits.filter((h) => h.groupKey === 'c200')).toEqual([]);
    expect(hits.filter((h) => h.id === 10 || h.id === 11).map((h) => [h.id, h.groupKey, h.possible])).toEqual(
      expect.arrayContaining([
        [10, 's10', false],
        [11, 's11', false],
      ]),
    );
  });

  it('search with a shop filter only returns that shop', async () => {
    const hits = await data.search({ text: 'lenovo ideapad', like: '%lenovo ideapad%' }, 'beta');
    expect(new Set(hits.map((h) => h.shopSlug))).toEqual(new Set(['beta']));
  });

  it('search with no letter or digit returns [] without a query', async () => {
    const base = runner(pg);
    let calls = 0;
    const counted = createData({ query: (t, p) => (calls++, base.query(t, p)), transaction: (s) => (calls++, base.transaction(s)) });
    expect(await counted.search({ text: '%%%', like: '%\\%\\%\\%%' }, null)).toEqual([]);
    expect(await counted.search({ text: `"'!?`, like: `%"'!?%` }, null)).toEqual([]);
    expect(calls).toBe(0);
    await counted.search({ text: 'ab', like: '%ab%' }, null);
    expect(calls).toBe(1);
  });

  it('search survives punctuation, quotes and wildcards', async () => {
    expect(await data.search({ text: '%%%', like: '%\\%\\%\\%%' }, null)).toEqual([]);
    expect(await data.search({ text: '%%ab%%', like: '%\\%\\%ab\\%\\%%' }, null)).toEqual([]);
    expect(await data.search({ text: `o'neill "x"`, like: `%o'neill "x"%` }, null)).toEqual([]);
    expect(await data.search({ text: 'a_b', like: '%a\\_b%' }, null)).toEqual([]);
  });

  it('shops lists visible shops with fresh products', async () => {
    expect(await data.shops()).toEqual([
      { slug: 'alpha', name: 'Alpha', grade: 'B', products: 4, logoUrl: null, logoAspect: null },
      { slug: 'beta', name: 'Beta', grade: null, products: 5, logoUrl: null, logoAspect: null },
    ]);
  });

  it('shop gives info, rating and live stats; hidden or inactive shops are null', async () => {
    expect(await data.shop('hidden')).toBeNull();
    expect(await data.shop('gone')).toBeNull();
    expect(await data.shop('nope')).toBeNull();
    const alpha = await data.shop('alpha');
    expect(alpha).toEqual({
      shop: { id: 1, slug: 'alpha', name: 'Alpha', url: 'https://alpha.example', category: 'electronics', logoUrl: null, logoAspect: null },
      rating: { grade: 'B', sentence: 'Mostly honest. A few deals need a closer look.', judged: 30 },
      stats: { products: 4, judged: 3, good: 1, avoid: 1, wasRaised: 0, bfMarked: 3, realDealPct: 33.3 },
    });
    expect((await data.shop('beta'))?.rating).toBeNull();
  });

  it('shopChanges finds rises and drops of the shown variant over 14 days', async () => {
    const c = await data.shopChanges(1, 14);
    expect(c.rises).toEqual([expect.objectContaining({ id: 7, title: 'Samsung Galaxy Tab', fromCents: 40000, toCents: 48000, pct: 20 })]);
    expect(c.drops).toEqual([expect.objectContaining({ id: 1, fromCents: 80000, toCents: 70000, pct: -12.5 })]);
    expect(c.drops[0].at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });

  it('product gives the group, variants, 60-day history of every variant and other shops', async () => {
    const d = await data.product(1);
    expect(d?.product).toMatchObject({ id: 1, productId: 10, shopId: 1, shopSlug: 'alpha', priceCents: 70000, bf: true, canonicalId: 100, verdict: 'good' });
    expect(d?.product.facts?.realPct).toBe(-12.5);
    expect(d?.variants).toEqual([
      { id: 10, title: 'Lenovo IdeaPad Slim 5', variantTitle: '16GB', priceCents: 70000, inStock: true },
      { id: 11, title: 'Lenovo IdeaPad Slim 5', variantTitle: '32GB', priceCents: 95000, inStock: false },
    ]);
    expect(d?.history.map((h) => [h.productId, h.price, h.bf])).toEqual([
      [10, 80000, true],
      [11, 95000, false],
      [10, 70000, true],
    ]);
    expect(typeof d?.history[0].at).toBe('string');
    // hidden, inactive and stale rows of canonical 100 are not listed
    expect(d?.others).toEqual([
      { id: 2, title: 'Lenovo IdeaPad Slim 5 Laptop', shop: 'Beta', shopSlug: 'beta', priceCents: 60000, inStock: true, verdict: 'none', matchMethod: 'gtin', possible: false },
    ]);
  });

  it('history keeps the newest points when a group has more than the cap', async () => {
    const capped = createData(runner(pg), { historyMax: 2 });
    const d = await capped.product(1);
    expect(d?.history.map((h) => [h.productId, h.price])).toEqual([
      [11, 95000],
      [10, 70000],
    ]);
  });

  it('a zero price or was price in history and variants serialises as null', async () => {
    const d = await data.product(12);
    expect(d?.product.priceCents).toBeNull();
    expect(d?.product.wasCents).toBeNull();
    expect(d?.variants.map((v) => v.priceCents)).toEqual([null]);
    expect(d?.history.map((h) => [h.price, h.was])).toEqual([[null, null]]);
  });

  it('product marks title-only matches as possible', async () => {
    const d = await data.product(11);
    expect(d?.others.map((o) => [o.id, o.possible])).toEqual([[10, true]]);
  });

  it('product is null for unknown, hidden-shop, inactive-shop and stale rows', async () => {
    for (const id of [999, 4, 5, 6]) expect(await data.product(id), String(id)).toBeNull();
  });

  it('categories count visible fresh rows', async () => {
    const c = await data.categories();
    expect(c.find((x) => x.slug === 'laptops')).toEqual({ slug: 'laptops', count: 6, good: 2, avoid: 0 });
    expect(c.find((x) => x.slug === 'phones')).toEqual({ slug: 'phones', count: 2, good: 0, avoid: 2 });
  });

  it('categories report rows without a category under the empty slug', async () => {
    const c = await data.categories();
    expect(c.find((x) => x.slug === '')).toEqual({ slug: '', count: 1, good: 0, avoid: 1 });
  });
});

describe('data.ts search and price order (fix round 1)', () => {
  it('search hits carry the raise facts and the stock flag', async () => {
    const hits = await data.search({ text: 'samsung galaxy tab', like: '%samsung galaxy tab%' }, null);
    const tab = hits.find((h) => h.id === 7);
    expect(tab?.raisedFrom).toEqual({ priceCents: 40000, at: '2026-10-10' });
    expect(tab?.inStock).toBe(true);
  });

  it('a stored 0 price sorts last (as no price) in search groups and in other shops', async () => {
    await pg.exec(`
      insert into shops (id, slug, name, base_url, adapter, active, site_hidden, category) values
        (5, 'delta', 'Delta', 'https://delta.example', 'woo', true, false, null);
      insert into site_products (id, shop_id, group_key, title, category, price_cents, in_stock, verdict, canonical_id, match_method, match_confirmed, updated_at) values
        (50, 1, 'Z50', 'Zeta Widget Pro', null, 0, true, 'insufficient', 300, 'gtin', false, now()),
        (51, 2, 'Z51', 'Zeta Widget Pro', null, 5000, true, 'insufficient', 300, 'gtin', false, now()),
        (52, 5, 'Z52', 'Zeta Widget Pro', null, 4000, false, 'insufficient', 300, 'gtin', false, now());
    `);
    const hits = (await data.search({ text: 'zeta widget pro', like: '%zeta widget pro%' }, null)).filter((h) => h.groupKey === 'c300');
    expect(hits.map((h) => h.id)).toEqual([52, 51, 50]);
    expect(hits.map((h) => h.inStock)).toEqual([false, true, true]);
    const d = await data.product(51);
    expect(d?.others.map((o) => [o.id, o.priceCents])).toEqual([
      [52, 4000],
      [50, null],
    ]);
  });
});

describe('data.ts shopChanges window (M4)', () => {
  it('looks back the given number of days', async () => {
    // product 20: 40000 five days ago, 48000 one day ago
    expect((await data.shopChanges(1, 14)).rises.map((r) => r.id)).toContain(7);
    expect((await data.shopChanges(1, 4)).rises.map((r) => r.id)).not.toContain(7);
  });
});

describe('data.ts flagged readings (Ruling R55)', () => {
  it('product history leaves out readings flagged jump_70pct', async () => {
    await pg.exec(`
      insert into price_observations (product_id, observed_at, price_cents, was_price_cents, in_stock, bf_marked, review_flag) values
        (10, now() - interval '12 hours', 290000, null, true, true, 'jump_70pct'),
        (10, now() - interval '6 hours', 71000, null, true, true, null);
    `);
    const d = await data.product(1);
    const prices = d?.history.filter((h) => h.productId === 10).map((h) => h.price);
    expect(prices).toEqual([80000, 70000, 71000]);
  });

  it('a variant shows its latest unflagged price, not a flagged jump', async () => {
    await pg.exec(`
      insert into price_observations (product_id, observed_at, price_cents, was_price_cents, in_stock, bf_marked, review_flag) values
        (11, now() - interval '1 hour', 990000, null, true, null, 'jump_70pct');
    `);
    const d = await data.product(1);
    expect(d?.variants.find((v) => v.id === 11)?.priceCents).toBe(95000);
  });
});

describe('data.ts shop stats count judged products like the rating (Ruling R53)', () => {
  it('a none with judged facts counts as judged; a none without does not', async () => {
    const before = (await data.shop('beta'))!.stats;
    await pg.exec(`
      insert into site_products (id, shop_id, group_key, title, price_cents, verdict, facts, updated_at) values
        (60, 2, 'NJ', 'Judged none', 1000, 'none', '{"judged": true}', now()),
        (61, 2, 'NU', 'Unjudged none', 1000, 'none', '{"judged": false}', now()),
        (62, 2, 'NS', 'Stale judged none', 1000, 'none', '{"judged": true}', now() - interval '3 days');
    `);
    const after = (await data.shop('beta'))!.stats;
    expect(after.judged).toBe(before.judged + 1);
    expect(after.realDealPct).toBe(Math.round((1000 * after.good) / after.judged) / 10);
  });
});

describe('data.ts search groups only trusted matches (final review I1)', () => {
  beforeAll(async () => {
    await pg.exec(`
      insert into site_products (id, shop_id, group_key, title, price_cents, in_stock, verdict, canonical_id, match_method, match_confirmed, updated_at) values
        -- the live case: a Lenovo title-matched (unconfirmed) with a cheaper Acer at another shop
        (70, 1, 'L70', 'Lenovo IdeaPad Slim 3 15IAN8', 39900, true, 'none', 700, 'title', false, now()),
        (71, 2, 'A71', 'Acer Aspire Lite 15 AL15', 29900, true, 'none', 700, 'title', false, now()),
        -- a confirmed title group: the confirmed rows group, the unconfirmed one does not join
        (72, 1, 'L72', 'Lenovo Tab M11 128GB', 19900, true, 'none', 701, 'title', true, now()),
        (73, 2, 'L73', 'Lenovo Tab M11 128 GB tablet', 18900, true, 'none', 701, 'title', true, now()),
        (74, 5, 'L74', 'Protective sleeve 11 inch', 1500, true, 'none', 701, 'title', false, now()),
        -- order: the best hit's group first, whatever its key
        (75, 1, 'Q75', 'Quokka Phone', 50000, true, 'none', null, null, false, now()),
        (76, 2, 'Q76', 'Quokka Phone Case', 1000, true, 'none', 702, 'gtin', false, now()),
        (77, 5, 'Q77', 'QPC-1 protective cover', 900, true, 'none', 702, 'gtin', false, now());
    `);
  });

  it('never pulls a title-only match into a hit group (Lenovo / Acer)', async () => {
    const hits = await data.search({ text: 'lenovo ideapad slim 3', like: '%lenovo ideapad slim 3%' }, null);
    const own = hits.filter((h) => h.groupKey === 's70');
    expect(own.map((h) => h.id)).toEqual([70]);
    expect(own[0].groupTitle).toBe('Lenovo IdeaPad Slim 3 15IAN8');
    expect(hits.map((h) => h.id)).not.toContain(71);
  });

  it('expands a confirmed group only to its confirmed members', async () => {
    const hits = await data.search({ text: 'lenovo tab m11', like: '%lenovo tab m11%' }, null);
    const g = hits.filter((h) => h.groupKey === 'c701');
    expect(g.map((h) => h.id).sort()).toEqual([72, 73]);
    expect(g.every((h) => !h.possible)).toBe(true);
    expect(hits.map((h) => h.id)).not.toContain(74);
  });

  it('orders groups by their best hit and titles them after it', async () => {
    const hits = await data.search({ text: 'quokka phone', like: '%quokka phone%' }, null);
    const keys = [...new Set(hits.map((h) => h.groupKey))];
    expect(keys).toEqual(['s75', 'c702']);
    const g = hits.filter((h) => h.groupKey === 'c702');
    // the cheaper member is listed, but the group is named after the row that matched the search
    expect(g.map((h) => h.id)).toEqual([77, 76]);
    expect(new Set(g.map((h) => h.groupTitle))).toEqual(new Set(['Quokka Phone Case']));
  });
});

describe('data.ts groups judged matches like barcode matches (design Update 23 Oct, afternoon)', () => {
  beforeAll(async () => {
    await pg.exec(`
      insert into site_products (id, shop_id, group_key, title, price_cents, in_stock, verdict, canonical_id, match_method, match_confirmed, updated_at) values
        (90, 1, 'W90', 'Wombat Speaker Mini 2', 5000, true, 'none', 790, 'judged', false, now()),
        (91, 2, 'W91', 'WOMBAT SPEAKER MINI 2 BLACK', 4500, true, 'none', 790, 'judged', false, now());
    `);
  });

  it('lists both sellers of a judged product in one group', async () => {
    const hits = await data.search({ text: 'wombat speaker mini', like: '%wombat speaker mini%' }, null);
    const g = hits.filter((h) => h.groupKey === 'c790');
    expect(g.map((h) => h.id)).toEqual([91, 90]);
    expect(g.every((h) => !h.possible)).toBe(true);
  });
});

describe('data.ts products by clean name (design Part 3)', () => {
  beforeAll(async () => {
    await pg.exec(`
      insert into name_runs (id, model) values (1, 'test');
      insert into products (id, shop_id, external_id, parent_external_id, title, variant_title, bf_status) values
        (800, 1, 'n80-b', 'N80', 'SAMSUNG Galaxy S25 Ultra 256GB', 'Black', null),
        (801, 1, 'n80-g', 'N80', 'SAMSUNG Galaxy S25 Ultra 256GB', 'Grey', null),
        (810, 2, 'N81', null, 'SM-S938B 256GB Titanium Black', null, 'marked'),
        (820, 5, 'N82', null, 'S25 Ultra case', null, null);
      insert into price_observations (product_id, observed_at, price_cents, was_price_cents, in_stock, bf_marked) values
        (800, now() - interval '2 days', 130000, null, true, null),
        (800, now() - interval '1 day', 125000, 140000, true, null),
        (801, now() - interval '1 day', 126000, null, false, null),
        (810, now() - interval '3 days', 119900, null, true, true),
        (810, now() - interval '1 day', 119900, null, true, true),
        (820, now() - interval '1 day', 1500, null, true, null);
      insert into site_products (id, shop_id, group_key, title, brand, category, rep_product_id, price_cents, was_price_cents, in_stock,
          bf_status, verdict, reason, facts, canonical_id, match_method, match_confirmed, image_key, url, updated_at) values
        (80, 1, 'N80', 'SAMSUNG Galaxy S25 Ultra 256GB', 'SAMSUNG', 'phones', 800, 125000, 140000, true, null, 'none', 'r80', null, 800, 'name', false,
          'img/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp', 'https://alpha.example/s25', now()),
        (81, 2, 'N81', 'SM-S938B 256GB Titanium Black', 'Samsung', 'phones', 810, 119900, null, true, 'marked', 'insufficient', 'r81', null, 800, 'name', false,
          'images/"+K+".jpg', 'javascript:alert(1)', now()),
        (82, 5, 'N82', 'S25 Ultra case', null, 'phones', 820, 1500, null, true, null, 'none', null, null, 800, 'title', false, null, null, now());
      insert into product_names (shop_id, group_key, source_title, title_hash, category, display_name, variant_label, attrs, status, model, run_id) values
        (1, 'N80', 'SAMSUNG Galaxy S25 Ultra 256GB', 'h', 'phones', 'Samsung Galaxy S25 Ultra Smartphone', '256GB, 12GB', '{"storage_gb": 256, "ram_gb": 12}', 'ok', 'test', 1),
        (2, 'N81', 'SM-S938B 256GB Titanium Black', 'h', 'phones', 'Samsung Galaxy S25 Ultra Smartphone', '256GB, Titanium Black', '{"storage_gb": 256, "colour": ["black"]}', 'ok', 'test', 1),
        (5, 'N82', 'an older title', 'h', 'phones', 'Samsung Galaxy S25 Ultra Case', null, '{}', 'ok', 'test', 1);
    `);
  });

  it('search finds a listing by its clean name and groups name matches as one product', async () => {
    const hits = await data.search({ text: 'galaxy s25 ultra smartphone', like: '%galaxy s25 ultra smartphone%' }, null);
    const g = hits.filter((h) => h.groupKey === 'c800');
    // 81 has no such words in its shop title: found through its clean name
    expect(g.map((h) => h.id)).toEqual([81, 80]);
    expect(g[0]).toMatchObject({ displayName: 'Samsung Galaxy S25 Ultra Smartphone', variantLabel: '256GB, Titanium Black', nameCategory: 'phones', attrs: { storage_gb: 256, colour: ['black'] }, possible: false });
    // our stored copy as its site URL; a key that is not a small copy (an old full-size original) is no photo
    expect(g[1].imageUrl).toBe('/img/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp');
    expect(g[0].imageUrl).toBeNull();
    expect(g[0].groupTitle).toBe('Samsung Galaxy S25 Ultra Smartphone');
    // the title-only member is never pulled in
    expect(hits.map((h) => h.id)).not.toContain(82);
  });

  it('a clean name stored for an older shop title is not used', async () => {
    const hits = await data.search({ text: 's25 ultra case', like: '%s25 ultra case%' }, null);
    expect(hits.find((h) => h.id === 82)?.displayName).toBeNull();
  });

  it('productGroup gives every trusted seller, cheapest first, with variants and history per seller', async () => {
    const g = await data.productGroup('c800');
    expect(g?.key).toBe('c800');
    expect(g?.sellers.map((s) => [s.id, s.shopSlug, s.priceCents, s.productId])).toEqual([
      [81, 'beta', 119900, 810],
      [80, 'alpha', 125000, 800],
    ]);
    expect(g?.sellers[1]).toMatchObject({ displayName: 'Samsung Galaxy S25 Ultra Smartphone', variantLabel: '256GB, 12GB', wasCents: 140000, bf: false, verdict: 'none', reason: 'r80' });
    expect(g?.sellers[0].bf).toBe(true);
    expect(g?.variants.map((v) => [v.sellerId, v.id, v.variantTitle, v.priceCents, v.inStock])).toEqual([
      [80, 800, 'Black', 125000, true],
      [80, 801, 'Grey', 126000, false],
      [81, 810, null, 119900, true],
    ]);
    expect(g?.history.map((h) => [h.sellerId, h.productId, h.price])).toEqual([
      [81, 810, 119900],
      [80, 800, 130000],
      [80, 800, 125000],
      [80, 801, 126000],
      [81, 810, 119900],
    ]);
  });

  it('a trusted listing key gives its product; a title-only listing is its own product', async () => {
    expect((await data.productGroup('s80'))?.key).toBe('c800');
    const alone = await data.productGroup('s82');
    expect(alone?.key).toBe('s82');
    expect(alone?.sellers.map((s) => s.id)).toEqual([82]);
    expect(alone?.sellers[0].displayName).toBeNull();
  });

  it('productGroup is null for unknown, malformed, title-only, hidden and stale keys', async () => {
    for (const key of ['c999', 's999', 'x80', 'c', 'c800x', 'c200', 's4', 's6', 'c1234567890123456']) expect(await data.productGroup(key), key).toBeNull();
  });

  it("caps the history per seller, keeping each seller its newest points and its verdict variant's whole 60 days", async () => {
    const g = await createData(runner(pg), { historyMax: 2 }).productGroup('c800');
    // per seller the newest reading (800 and 801 read at the same time: the higher id first), and every reading of
    // the variant its verdict is about within the 60 days (review: a cap never cuts the raise window)
    expect(g?.history.map((h) => [h.sellerId, h.productId, h.price])).toEqual([
      [81, 810, 119900],
      [80, 800, 130000],
      [80, 800, 125000],
      [80, 801, 126000],
      [81, 810, 119900],
    ]);
  });

  it('gives each variant the time of its newest reading (review I3)', async () => {
    const g = await data.productGroup('c800');
    const seen = g?.variants.map((v) => [v.id, typeof v.seenAt === 'string' && /Z$/.test(v.seenAt)]);
    expect(seen).toEqual([
      [800, true],
      [801, true],
      [810, true],
    ]);
  });

  it("caps the variants per seller, always keeping the seller's verdict variant", async () => {
    await pg.exec('update site_products set rep_product_id = 801 where id = 80');
    try {
      const g = await createData(runner(pg), { variantsMax: 2 }).productGroup('c800');
      expect(g?.variants.map((v) => [v.sellerId, v.id])).toEqual([
        [80, 801],
        [81, 810],
      ]);
    } finally {
      await pg.exec('update site_products set rep_product_id = 800 where id = 80');
    }
  });

  it('follows the redirect of a removed product to the one its listings went to (review I4)', async () => {
    await pg.exec('insert into canonical_redirects (old_id, new_id) values (777, 800), (778, 999)');
    expect((await data.productGroup('c777'))?.key).toBe('c800');
    // a redirect to a product that is gone too is not found
    expect(await data.productGroup('c778')).toBeNull();
  });

  it("search counts every shop, Black Friday and verdict of a product, past the rows it lists (review)", async () => {
    const hits = await createData(runner(pg), { searchMembers: 1 }).search({ text: 'galaxy s25 ultra smartphone', like: '%galaxy s25 ultra smartphone%' }, null);
    const g = hits.filter((h) => h.groupKey === 'c800');
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ groupShops: 2, groupBf: true, groupGood: 0, groupAvoid: 0 });
  });

  it('the listing page gives the product key it belongs to', async () => {
    expect((await data.product(80))?.product.key).toBe('c800');
    expect((await data.product(82))?.product.key).toBe('s82');
    expect((await data.product(1))?.product.key).toBe('c100');
  });
});

describe('data.ts shown was prices (migration 015)', () => {
  it("history shows a shown_was shop's was price only where it was read from the shown price", async () => {
    await pg.exec(`
      insert into shops (id, slug, name, base_url, adapter, active, site_hidden, category, config) values
        (7, 'listshop', 'Listshop', 'https://list.example', 'woo', true, false, null,
         '{"shown_was": {"source": "price_html", "selector": ".atoz-price__list", "was_label": "List price"}}');
      insert into products (id, shop_id, external_id, title) values (70, 7, 'L1', 'Lenovo V15 G5');
      insert into price_observations (product_id, observed_at, price_cents, was_price_cents, was_source, feed_was_price_cents, in_stock) values
        (70, now() - interval '2 days', 79900, 80900, 'feed', 80900, true),
        (70, now() - interval '1 day', 79900, 80900, null, null, true),
        (70, now() - interval '2 hours', 79900, 96900, 'shown', 80900, true);
      insert into site_products (id, shop_id, group_key, title, rep_product_id, price_cents, was_price_cents, in_stock, verdict, updated_at) values
        (970, 7, 'L1', 'Lenovo V15 G5', 70, 79900, 96900, true, 'avoid', now());
    `);
    const d = await data.product(970);
    expect(d?.history.map((h) => [h.price, h.was, h.wasKnown])).toEqual([
      [79900, null, false],
      [79900, null, false],
      [79900, 96900, undefined],
    ]);
    const g = await data.productGroup('s970');
    expect(g?.history.map((h) => [h.was, h.wasKnown])).toEqual([
      [null, false],
      [null, false],
      [96900, undefined],
    ]);
    expect((await data.shop('listshop'))?.shop.wasLabel).toBe('List price');
    expect((await data.shop('alpha'))?.shop.wasLabel).toBeUndefined();
    // other shops keep their feed was prices (product 10 of shop alpha)
    expect((await data.product(1))?.history.some((h) => h.was === 90000)).toBe(true);
    // the shop's own term for its reference price, on the seller and its cards; none elsewhere
    expect((await data.productGroup('s970'))?.sellers.map((s) => s.wasLabel)).toEqual(['List price']);
    expect((await data.productGroup('c100'))?.sellers.every((s) => s.wasLabel === undefined)).toBe(true);
    const avoid = await data.deals({ verdict: 'avoid', category: null, shop: 'listshop', minCents: null, maxCents: null, limit: 24, offset: 0 });
    expect(avoid.items.map((c) => [c.id, c.wasLabel])).toEqual([[970, 'List price']]);
  });
});

describe('data.ts shop logos (migration 016)', () => {
  const LOGO = `img/${'d'.repeat(64)}.webp`;

  it("every shop payload carries the shop's logo as our /img address, null without one or for a key that is not ours", async () => {
    await pg.exec(`update shops set logo_key = '${LOGO}', logo_w = 256, logo_h = 40 where slug = 'alpha';
      update shops set logo_key = 'https://beta.example/logo.png', logo_w = 100, logo_h = 100 where slug = 'beta';`);
    try {
      const url = `/${LOGO}`;
      const ab = <T extends { shopSlug?: string; slug?: string }>(list: T[]) => list.filter((x) => ['alpha', 'beta'].includes(x.shopSlug ?? x.slug ?? ''));
      expect(ab(await data.shops()).map((s) => [s.slug, s.logoUrl])).toEqual([
        ['alpha', url],
        ['beta', null],
      ]);
      expect((await data.shop('alpha'))?.shop.logoUrl).toBe(url);
      // the stored copy's width / height (migration 017); none for a key that is not ours
      expect((await data.shop('alpha'))?.shop.logoAspect).toBe(6.4);
      expect((await data.shop('beta'))?.shop.logoAspect).toBeNull();
      expect(ab(await data.shops()).map((s) => s.logoAspect)).toEqual([6.4, null]);
      expect((await data.shop('beta'))?.shop.logoUrl).toBeNull();
      const good = await data.deals({ verdict: 'good', category: null, shop: null, minCents: null, maxCents: null, limit: 24, offset: 0 });
      expect(new Map(ab(good.items).map((c) => [c.shopSlug, c.logoUrl]))).toEqual(new Map([['beta', null], ['alpha', url]]));
      const hits = await data.search({ text: 'lenovo ideapad', like: '%lenovo ideapad%' }, null);
      expect(hits.find((h) => h.shopSlug === 'alpha')?.logoUrl).toBe(url);
      expect(hits.find((h) => h.shopSlug === 'beta')?.logoUrl).toBeNull();
      expect(new Map(ab((await data.productGroup('c100'))!.sellers).map((s) => [s.shopSlug, s.logoUrl]))).toEqual(new Map([['beta', null], ['alpha', url]]));
    } finally {
      await pg.exec(`update shops set logo_key = null, logo_w = null, logo_h = null`);
    }
  });
});
