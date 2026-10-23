// Platform detection for a requested shop (src/shop-requests/detect.ts) against recorded responses.
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/http/fetcher.js';
import {
  PROBE_PATHS,
  hasJsonLdProduct,
  htmlHints,
  looksLikeShopifyProducts,
  looksLikeWooProducts,
  magentoGraphqlRoot,
  probeShop,
} from '../../src/shop-requests/detect.js';
import { type Recorded, fakeFetcher, fixture } from './fake-fetcher.js';

const json = (name: string) => JSON.parse(fixture(name)) as unknown;

describe('response checks', () => {
  it('recognise each platform from its recorded answer and nothing else', () => {
    expect(looksLikeShopifyProducts(json('shopify-products.json'))).toBe(true);
    expect(looksLikeShopifyProducts(json('woo-products.json'))).toBe(false);
    expect(looksLikeShopifyProducts({ products: [] })).toBe(false);
    expect(looksLikeWooProducts(json('woo-products.json'))).toBe(true);
    expect(looksLikeWooProducts(json('shopify-products.json'))).toBe(false);
    expect(looksLikeWooProducts([])).toBe(false);
    expect(magentoGraphqlRoot(json('magento-graphql.json'))).toEqual({ ok: true, root: 2 });
    expect(magentoGraphqlRoot(json('magento-graphql-error.json'))).toEqual({ ok: false, root: null });
    expect(magentoGraphqlRoot('<html>')).toEqual({ ok: false, root: null });
  });

  it('reads platform hints from the home page and its headers', () => {
    expect(htmlHints(fixture('shopify-home.html'), new Headers())).toMatchObject({ shopify: true, woo: false, magento: false });
    expect(htmlHints('<html></html>', new Headers({ 'x-shopid': '123' })).shopify).toBe(true);
    expect(htmlHints(fixture('woo-home.html'), new Headers())).toMatchObject({ shopify: false, woo: true, magento: false, generator: ['WordPress 6.6.2', 'WooCommerce 9.3.1'] });
    expect(htmlHints(fixture('magento-home.html'), new Headers())).toMatchObject({ magento: true });
    expect(htmlHints('<html></html>', new Headers({ 'x-magento-cache-debug': 'HIT' })).magento).toBe(true);
    expect(htmlHints(fixture('unknown-home.html'), new Headers())).toMatchObject({ shopify: false, woo: false, magento: false, generator: ['PrestaShop'] });
  });

  it('finds JSON-LD Product data, also inside @graph', () => {
    expect(hasJsonLdProduct(fixture('unknown-product.html'))).toBe(true);
    expect(hasJsonLdProduct('<script type="application/ld+json">{"@type":["Product","Thing"]}</script>')).toBe(true);
    expect(hasJsonLdProduct('<script type="application/ld+json">{"@type":"Organization"}</script>')).toBe(false);
    expect(hasJsonLdProduct('<script type="application/ld+json">{not json</script>')).toBe(false);
  });
});

const O = 'https://shop.example.mt';
const page = (body: string, headers: Record<string, string> = {}): Recorded => ({ body, headers });

describe('probeShop', () => {
  it('Shopify: home page then products.json, three requests, name from og:site_name', async () => {
    const f = fakeFetcher(O, { [`${O}/`]: page(fixture('shopify-home.html')), [`${O}${PROBE_PATHS.shopify}`]: page(fixture('shopify-products.json')) });
    const d = await probeShop(f, O);
    expect(d).toMatchObject({ kind: 'supported', platform: 'shopify', adapter: 'shopify', config: {}, baseUrl: O, siteName: 'Tech & Toys Malta' });
    expect(d.robots).toMatchObject({ allowed: true, checked: [{ path: '/' }, { path: '/products.json' }] });
    expect(f.requests).toEqual([`${O}/robots.txt`, `${O}/`, `${O}${PROBE_PATHS.shopify}`]);
  });

  it('WooCommerce: tries the hinted Store API first', async () => {
    const f = fakeFetcher(O, { [`${O}/`]: page(fixture('woo-home.html')), [`${O}${PROBE_PATHS.woo}`]: page(fixture('woo-products.json')) });
    const d = await probeShop(f, O);
    expect(d).toMatchObject({ kind: 'supported', platform: 'woocommerce', adapter: 'woo', siteName: 'Garden Things' });
    expect(f.requests).toEqual([`${O}/robots.txt`, `${O}/`, `${O}${PROBE_PATHS.woo}`]);
  });

  it('Magento GraphQL: graphql with the root category', async () => {
    const f = fakeFetcher(O, { [`${O}/`]: page(fixture('magento-home.html')), [`${O}${PROBE_PATHS.magento}`]: page(fixture('magento-graphql.json')) });
    const d = await probeShop(f, O);
    expect(d).toMatchObject({ kind: 'supported', platform: 'magento-graphql', adapter: 'magento', config: { graphql: true, graphql_root: 2 }, siteName: 'Electro Hub' });
    expect(f.requests).toHaveLength(3);
  });

  it('Magento HTML: GraphQL errors but Magento markers on the page', async () => {
    const f = fakeFetcher(O, {
      [`${O}/`]: page(fixture('magento-home.html')),
      [`${O}${PROBE_PATHS.magento}`]: { status: 500, body: fixture('magento-graphql-error.json') },
    });
    const d = await probeShop(f, O);
    expect(d).toMatchObject({ kind: 'supported', platform: 'magento-html', adapter: 'magento', config: {} });
    expect(f.requests.length).toBeLessThanOrEqual(10);
  });

  it('unknown platform: needs setup, with what was found; text on the page changes nothing', async () => {
    const f = fakeFetcher(O, {
      [`${O}/`]: page(fixture('unknown-home.html'), { server: 'nginx', 'x-powered-by': 'PHP/8.2' }),
      [`${O}/en/men/1-hummingbird-printed-t-shirt.html`]: page(fixture('unknown-product.html')),
      [`${O}/en/women/2-brown-bear-printed-sweater.html`]: page('<html><title>Sweater</title></html>'),
    });
    const d = await probeShop(f, O);
    expect(d.kind).toBe('unsupported');
    if (d.kind !== 'unsupported') return;
    expect(d.platform).toBe('unknown');
    expect(d.siteName).toBe('Fashion Corner');
    expect(d.details).toMatchObject({
      server: 'nginx',
      poweredBy: 'PHP/8.2',
      generator: ['PrestaShop'],
      jsonLdProduct: true,
      productPagesChecked: ['/en/men/1-hummingbird-printed-t-shirt.html', '/en/women/2-brown-bear-printed-sweater.html'],
    });
    expect(d.details.categoryLinks).toEqual(expect.arrayContaining(['/en/category/shoes']));
    expect(d.details.categoryLinks.some((l) => l.includes('other.example.com'))).toBe(false);
    // robots, home, three probes, two product pages
    expect(f.requests).toHaveLength(7);
    expect(f.requests.length).toBeLessThanOrEqual(10);
  });

  it('follows a redirect to www. and uses that origin as the base address', async () => {
    const W = 'https://www.shop.example.mt';
    const f = fakeFetcher(O, {
      [`${O}/`]: { redirectTo: `${W}/` },
      [`${W}/`]: page(fixture('shopify-home.html')),
      [`${W}${PROBE_PATHS.shopify}`]: page(fixture('shopify-products.json')),
    });
    expect(await probeShop(f, O)).toMatchObject({ kind: 'supported', baseUrl: W });
  });

  it('blocked: robots.txt disallows the home page', async () => {
    const f = fakeFetcher(O, { [`${O}/`]: page(fixture('shopify-home.html')) }, { [O]: 'User-agent: *\nDisallow: /\n' });
    const d = await probeShop(f, O);
    expect(d).toMatchObject({ kind: 'blocked', reason: 'robots.txt blocks the home page: Disallow: / (line 2)' });
    expect(f.requests).toEqual([`${O}/robots.txt`]);
  });

  it('blocked: a Shopify shop whose robots.txt disallows the product feed; Crawl-delay recorded', async () => {
    const f = fakeFetcher(O, { [`${O}/`]: page(fixture('shopify-home.html')) }, { [O]: 'User-agent: *\nCrawl-delay: 6\nDisallow: /products.json\n' });
    const d = await probeShop(f, O);
    expect(d).toMatchObject({ kind: 'blocked', platform: 'shopify', reason: 'robots.txt blocks the Shopify product feed: Disallow: /products.json (line 3)' });
    expect(d.robots).toMatchObject({ allowed: false, crawlDelaySeconds: 6, blockedBy: { path: '/products.json' } });
    expect(f.requests).not.toContain(`${O}${PROBE_PATHS.shopify}`);
  });

  it('unreachable home page or a redirect to another site is an error, not a guess', async () => {
    const f403 = fakeFetcher(O, { [`${O}/`]: { status: 403, body: 'Just a moment...' } });
    expect(await probeShop(f403, O)).toMatchObject({ kind: 'unreachable', reason: expect.stringMatching(/HTTP 403/) });
    const away = fakeFetcher(O, { [`${O}/`]: { redirectTo: 'https://elsewhere.example.com/' } });
    expect(await probeShop(away, O)).toMatchObject({ kind: 'unreachable', reason: expect.stringMatching(/another site/) });
    const down = fakeFetcher(O, { [`${O}/`]: new HttpError(`${O}/`, 503) });
    expect(await probeShop(down, O)).toMatchObject({ kind: 'unreachable' });
  });

  it('robots.txt unreachable: blocked, nothing else fetched', async () => {
    const f = fakeFetcher(O, {});
    const { parseRobots } = await import('../../src/http/robots.js');
    f.robotsFor = async () => parseRobots(O, '', 'MTPIndex/1.0', 'unreachable');
    const d = await probeShop(f, O);
    expect(d).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/robots.txt could not be read/) });
    expect(f.requests).toEqual([]);
  });
});
