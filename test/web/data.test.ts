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
const avoidFacts = (from: number, to: number) =>
  JSON.stringify({ low30: from, usual: from, claimedPct: 10, realPct: 5, historyDays: 20, priceChanges: 1, wasChanges: 0, daysWorthBuying: 0, raisedFrom: { price: from, at: '2026-10-10' }, raisedTo: { price: to, at: '2026-10-20' } });

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
      (8, 2, 'B8', 'Beta avoid no price', 'phones', null, null, null, false, null, 'avoid', 'r8', '${avoidFacts(100, 110)}', null, null, false, now()),
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
    const r = await data.deals({ verdict: 'good', category: null, shop: null, limit: 24, offset: 0 });
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
    });
  });

  it('avoid deals keep null prices as null, largest rise first', async () => {
    const r = await data.deals({ verdict: 'avoid', category: null, shop: null, limit: 24, offset: 0 });
    expect(r.items.map((c) => c.id)).toEqual([7, 8, 12]);
    expect(r.items[1].priceCents).toBeNull();
    expect(r.items[1].wasCents).toBeNull();
    // a stored 0 is no price either
    expect(r.items[2].priceCents).toBeNull();
    expect(r.items[2].wasCents).toBeNull();
  });

  it('filters by category and shop, and reports the total past the last page', async () => {
    expect((await data.deals({ verdict: 'good', category: 'laptops', shop: 'alpha', limit: 24, offset: 0 })).items.map((c) => c.id)).toEqual([1]);
    expect((await data.deals({ verdict: 'good', category: 'phones', shop: null, limit: 24, offset: 0 })).items).toEqual([]);
    expect(await data.deals({ verdict: 'good', category: null, shop: null, limit: 24, offset: 48 })).toEqual({ items: [], total: 2 });
    expect((await data.deals({ verdict: 'good', category: null, shop: 'hidden', limit: 24, offset: 0 })).total).toBe(0);
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
    const g200 = hits.filter((h) => h.groupKey === 'c200');
    expect(g200.map((h) => h.id).sort()).toEqual([10, 11]);
    expect(g200.every((h) => h.possible)).toBe(true);
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
      { slug: 'alpha', name: 'Alpha', grade: 'B', products: 4 },
      { slug: 'beta', name: 'Beta', grade: null, products: 5 },
    ]);
  });

  it('shop gives info, rating and live stats; hidden or inactive shops are null', async () => {
    expect(await data.shop('hidden')).toBeNull();
    expect(await data.shop('gone')).toBeNull();
    expect(await data.shop('nope')).toBeNull();
    const alpha = await data.shop('alpha');
    expect(alpha).toEqual({
      shop: { id: 1, slug: 'alpha', name: 'Alpha', url: 'https://alpha.example', category: 'electronics' },
      rating: { grade: 'B', sentence: 'Mostly honest. A few deals need a closer look.', judged: 30 },
      stats: { products: 4, judged: 3, good: 1, avoid: 1, wasRaised: 0, bfMarked: 3, realDealPct: 33.3 },
    });
    expect((await data.shop('beta'))?.rating).toBeNull();
  });

  it('shopChanges finds rises and drops of the shown variant over 14 days', async () => {
    const c = await data.shopChanges(1);
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
});
