// The was price shoppers see struck through (config.shown_was, migration 015), on real AtoZ markup saved 24 Oct 2026:
// the Store API answers (test/fixtures/atoz/store-api-*.json) and the product page's price block and listing cards
// (test/fixtures/atoz/product-page.html), trimmed.
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { readShownWas, shownWasAlarm, shownWasConfig, type ShownWasConfig } from '../src/adapters/shownWas.js';
import { woo, wooToRecord } from '../src/adapters/woo.js';
import type { CrawlContext, Shop } from '../src/types.js';
import { detectBlackFriday } from '../src/util/blackfriday.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/atoz/${name}`, import.meta.url), 'utf8');
type WooProduct = Parameters<typeof wooToRecord>[0];
const lenovo = JSON.parse(fixture('store-api-product-261895.json')) as WooProduct & { price_html: string };
const listing = JSON.parse(fixture('store-api-listing.json')) as (WooProduct & { id: number })[];
const byId = (id: number) => listing.find((p) => p.id === id)!;

const seed = JSON.parse(readFileSync(new URL('../shops.seed.json', import.meta.url), 'utf8')) as { shops: Shop[] };
const atoz = seed.shops.find((s) => s.slug === 'atoz')!;
const CFG = shownWasConfig(atoz.config)!;

describe('shownWasConfig', () => {
  it("reads AtoZ's config from shops.seed.json", () => {
    expect(CFG).toEqual({
      source: 'price_html',
      selector: '.atoz-price__list',
      label_selector: '.atoz-price__name',
      ignore_selector: '.atoz-price__teaser',
      was_label: 'List price',
    });
  });

  it('is null without a config and throws on a malformed one', () => {
    expect(shownWasConfig({})).toBeNull();
    expect(() => shownWasConfig({ shown_was: { source: 'product_html', selector: '.x' } })).toThrow(/source/);
    expect(() => shownWasConfig({ shown_was: { source: 'price_html' } })).toThrow(/selector/);
    expect(() => shownWasConfig({ shown_was: { source: 'price_html', selector: '.x', was_label: '' } })).toThrow(/was_label/);
    expect(() => shownWasConfig({ shown_was: { source: 'price_html', selector: '.x', was_label: 'x'.repeat(41) } })).toThrow(/was_label/);
  });
});

describe('readShownWas', () => {
  it('reads the struck-through List Price and the price name from the Store API price_html (Lenovo 261895)', () => {
    expect(lenovo.prices.regular_price).toBe('80900');
    expect(readShownWas(lenovo.price_html, CFG, 79900, 80900)).toEqual({ wasCents: 96900, label: 'Black Friday', found: 'selector', struck: true });
  });

  it('reads the same values from the product page price block, so price_html is what shoppers see', () => {
    const $ = cheerio.load(fixture('product-page.html'));
    const block = $('#product-261895 p.price').html()!;
    expect(readShownWas(block, CFG, 79900, 80900)).toEqual({ wasCents: 96900, label: 'Black Friday', found: 'selector', struck: true });
  });

  it('reads listing cards, and never the member price (zOnePRICE)', () => {
    const $ = cheerio.load(fixture('product-page.html'));
    const cards = $('li.product')
      .toArray()
      .map((li) => readShownWas($(li).find('span.price').html(), CFG, null, null));
    expect(cards).toEqual([
      { wasCents: 155900, label: 'Black Friday', found: 'selector', struck: true },
      { wasCents: 179900, label: 'Cash Price', found: 'selector', struck: true },
    ]);
    // without the ignore rule the teaser is still never taken for the list price
    const noIgnore: ShownWasConfig = { ...CFG, ignore_selector: undefined };
    expect(readShownWas($('li.product').eq(1).find('span.price').html(), noIgnore, 149900, null).wasCents).toBe(179900);
  });

  it('falls back to the feed regular price only when the markup strikes exactly that price through', () => {
    const wooSale = '<del aria-hidden="true"><span class="amount">&euro;809.00</span></del> <ins><span class="amount">&euro;799.00</span></ins>';
    expect(readShownWas(wooSale, CFG, 79900, 80900)).toEqual({ wasCents: 80900, label: null, found: 'struck_feed', struck: true });
    // a struck price other than the feed's, or none at all: unknown, never the feed value
    expect(readShownWas(wooSale, CFG, 79900, 82900)).toEqual({ wasCents: null, label: null, found: 'none', struck: true });
    expect(readShownWas('<span class="amount">&euro;799.00</span>', CFG, 79900, 80900)).toEqual({ wasCents: null, label: null, found: 'none', struck: false });
    expect(readShownWas(undefined, CFG, 79900, 80900)).toEqual({ wasCents: null, label: null, found: 'no_html', struck: false });
  });

  it('keeps a shown price at or below the price out of the was price', () => {
    expect(readShownWas(lenovo.price_html, CFG, 96900, 80900).wasCents).toBeNull();
  });
});

describe('woo adapter with shown_was', () => {
  it('records the shown List Price as the was price, keeps the feed regular price for audit, and the price name as badge', () => {
    const r = wooToRecord(lenovo, undefined, CFG);
    expect(r).toMatchObject({
      external_id: '261895',
      price_cents: 79900,
      was_price_cents: 96900,
      was_source: 'shown',
      feed_was_price_cents: 80900,
      on_sale: true,
      badge_text: 'Black Friday',
    });
  });

  it('without the config keeps the feed regular price, labelled feed', () => {
    const r = wooToRecord(lenovo);
    expect(r.was_price_cents).toBe(80900);
    expect(r.was_source).toBe('feed');
    expect(r.feed_was_price_cents).toBeUndefined();
  });

  it('covers the listing cases: Black Friday, Cash Price with and without a List Price', () => {
    const rows = [293463, 293461, 293486].map((id) => {
      const r = wooToRecord(byId(id), undefined, CFG);
      return [id, r.price_cents, r.was_price_cents, r.feed_was_price_cents, r.badge_text, r.on_sale];
    });
    expect(rows).toEqual([
      [293463, 42900, 53900, 44900, 'Black Friday', true],
      // a regular-priced product that still shows a struck-through List Price: shoppers see a reference price
      [293461, 229900, 275900, null, 'Cash Price', true],
      [293486, 25295, null, null, 'Cash Price', false],
    ]);
  });

  it('feeds the shown price name to the Black Friday marker detection', () => {
    // no tags or categories: the "Black Friday" price name alone marks the product
    const bare = { ...byId(293463), tags: [], categories: [] };
    expect(detectBlackFriday(wooToRecord(bare, undefined, CFG))).toEqual({ status: 'marked', marker: 'badge: Black Friday' });
    expect(detectBlackFriday(wooToRecord({ ...byId(293461), tags: [], categories: [] }, undefined, CFG))).toBeNull();
  });

  function ctxFor(answers: Record<string, unknown>): { ctx: CrawlContext; urls: string[] } {
    const urls: string[] = [];
    const fetcher = {
      async get(url: string) {
        urls.push(url);
        const path = url.replace('https://atoz.com.mt', '');
        const body = answers[path];
        if (body === undefined) throw new Error(`unexpected ${url}`);
        return { url, status: 200, headers: new Headers({ 'x-wp-totalpages': '1' }), json: () => body };
      },
    };
    const shop: Shop = { ...atoz, id: 1 };
    const ctx = { shop, fetcher, log: () => {}, error: () => {} } as unknown as CrawlContext;
    return { ctx, urls };
  }

  it('crawl reads the shown was from the listing it already fetches: no extra request', async () => {
    const { ctx, urls } = ctxFor({ '/wp-json/wc/store/v1/products?per_page=25&page=1': listing });
    const out = [];
    for await (const batch of woo.crawl(ctx)) out.push(...batch);
    expect(urls).toEqual(['https://atoz.com.mt/wp-json/wc/store/v1/products?per_page=25&page=1']);
    expect(out.map((r) => [r.external_id, r.was_price_cents, r.was_source])).toEqual([
      ['293486', null, 'shown'],
      ['293463', 53900, 'shown'],
      ['293461', 275900, 'shown'],
    ]);
  });

  it('fetchOne (due runs) reads it from the single product answer', async () => {
    const { ctx, urls } = ctxFor({ '/wp-json/wc/store/v1/products/261895': lenovo });
    const [r] = await woo.fetchOne(ctx, { id: 1, external_id: '261895', parent_external_id: null, url: null, meta: {} });
    expect(urls).toHaveLength(1);
    expect([r!.was_price_cents, r!.feed_was_price_cents, r!.was_source]).toEqual([96900, 80900, 'shown']);
  });
});

describe('readShownWas amounts', () => {
  const read = (inner: string) => readShownWas(`<del class="atoz-price__list">${inner}</del>`, CFG, 79900, null).wasCents;

  it('takes the amount right after a currency sign, without the full stop that ends a sentence', () => {
    expect(read('Original price was: €969.00.')).toBe(96900);
    expect(read('Original price was: &euro;1,559.00.')).toBe(155900);
  });

  it('never takes a year or another number before the price', () => {
    expect(read('RRP 2026 €969.00')).toBe(96900);
    expect(read('RRP 2026 EUR 969.00')).toBe(96900);
  });

  it('without a currency sign takes the last amount in the element', () => {
    expect(read('List 2026: 969.00')).toBe(96900);
  });

  it('reads the price name without script or style text', () => {
    const html = '<span class="atoz-price__name">Black Friday<script>var x = 1;</script><style>.a{}</style></span><del class="atoz-price__list">€969.00</del>';
    expect(readShownWas(html, CFG, 79900, null).label).toBe('Black Friday');
  });
});

describe('shown_was markup-change alarm', () => {
  it('stays quiet while the selector finds the struck price on at least half of the struck-price products', () => {
    expect(shownWasAlarm({ struck: 0, hits: 0 }, CFG)).toBeNull();
    expect(shownWasAlarm({ struck: 10, hits: 10 }, CFG)).toBeNull();
    expect(shownWasAlarm({ struck: 10, hits: 5 }, CFG)).toBeNull();
  });

  it('alarms when the selector finds none, or under half, of the struck prices (the markup changed)', () => {
    expect(shownWasAlarm({ struck: 10, hits: 0 }, CFG)).toMatch(/shown_was selector \.atoz-price__list found 0 of 10/);
    expect(shownWasAlarm({ struck: 10, hits: 4 }, CFG)).toMatch(/found 4 of 10/);
  });

  function crawlCtx(items: unknown[]) {
    const errors: string[] = [];
    const fetcher = {
      async get(url: string) {
        return { url, status: 200, headers: new Headers({ 'x-wp-totalpages': '1' }), json: () => items };
      },
    };
    const ctx = { shop: { ...atoz, id: 1 }, fetcher, log: () => {}, error: (m: string) => errors.push(m) } as unknown as CrawlContext;
    return { ctx, errors };
  }

  it('a crawl whose struck prices the selector no longer finds calls ctx.error, so the run is partial and alerts', async () => {
    // the shop's theme changed: plain Woo <del>/<ins> markup, no .atoz-price__list
    const changed = listing.map((p) => ({ ...p, price_html: '<del><span class="amount">&euro;539.00</span></del> <ins><span class="amount">&euro;429.00</span></ins>' }));
    const { ctx, errors } = crawlCtx(changed);
    for await (const batch of woo.crawl(ctx)) void batch;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/shown_was selector \.atoz-price__list found 0 of 3/);
  });

  it('a crawl of the usual markup calls no error', async () => {
    const { ctx, errors } = crawlCtx(listing);
    for await (const batch of woo.crawl(ctx)) void batch;
    expect(errors).toEqual([]);
  });
});
