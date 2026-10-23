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
  magentoProductsPath,
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
    const f = fakeFetcher(O, {
      [`${O}/`]: page(fixture('magento-home.html')),
      [`${O}${PROBE_PATHS.magento}`]: page(fixture('magento-graphql.json')),
      [`${O}${magentoProductsPath(2)}`]: page(fixture('magento-products.json')),
    });
    const d = await probeShop(f, O);
    expect(d).toMatchObject({ kind: 'supported', platform: 'magento-graphql', adapter: 'magento', config: { graphql: true, graphql_root: 2 }, siteName: 'Electro Hub' });
    // storeConfig, then the adapter's own products query with pageSize 1
    expect(f.requests).toEqual([`${O}/robots.txt`, `${O}/`, `${O}${PROBE_PATHS.magento}`, `${O}${magentoProductsPath(2)}`]);
  });

  it('Magento HTML: GraphQL answers with errors but Magento markers are on the page', async () => {
    const f = fakeFetcher(O, {
      [`${O}/`]: page(fixture('magento-home.html')),
      [`${O}${PROBE_PATHS.magento}`]: page(fixture('magento-graphql-error.json')),
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
    const away403 = fakeFetcher(O, { [`${O}/`]: { status: 202, body: '<html>checking your browser</html>' } });
    expect(await probeShop(away403, O)).toMatchObject({ kind: 'unreachable', reason: expect.stringMatching(/HTTP 202.*not worked around/) });
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

describe('probeShop: rate limits, bot checks, slow shops and Magento product lists', () => {
  it('a 429 on the home page stops at once with its Retry-After; nothing else is fetched', async () => {
    const f = fakeFetcher(O, { [`${O}/`]: { status: 429, body: 'slow down', headers: { 'retry-after': '7200' } } });
    const d = await probeShop(f, O);
    expect(d).toMatchObject({ kind: 'rate_limited', retryAfterMs: 7_200_000, reason: expect.stringMatching(/home page answered HTTP 429/) });
    expect(f.requests).toEqual([`${O}/robots.txt`, `${O}/`]);
  });

  it('a 503 on a feed probe stops at once: no other path is tried', async () => {
    const f = fakeFetcher(O, { [`${O}/`]: page(fixture('shopify-home.html')), [`${O}${PROBE_PATHS.shopify}`]: { status: 503, body: 'busy' } });
    const d = await probeShop(f, O);
    expect(d).toMatchObject({ kind: 'rate_limited', retryAfterMs: null });
    expect(f.requests).toEqual([`${O}/robots.txt`, `${O}/`, `${O}${PROBE_PATHS.shopify}`]);
  });

  it('robots.txt answering 429 is rate limiting, not a block', async () => {
    const f = fakeFetcher(O, {}, { [O]: { status: 429, retryAfterMs: 60_000 } });
    expect(await probeShop(f, O)).toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000, reason: expect.stringMatching(/robots\.txt answered HTTP 429/) });
    expect(f.requests).toEqual([`${O}/robots.txt`]);
  });

  it('a 403 from a probe is a bot check: failed, nothing more fetched', async () => {
    const f = fakeFetcher(O, { [`${O}/`]: page(fixture('unknown-home.html')), [`${O}${PROBE_PATHS.shopify}`]: { status: 403, body: 'denied' } });
    const d = await probeShop(f, O);
    expect(d).toMatchObject({ kind: 'unreachable', reason: expect.stringMatching(/HTTP 403.*not worked around/) });
    expect(f.requests).toHaveLength(3);
  });

  it('a 429 on a product page of an unknown shop stops too', async () => {
    const f = fakeFetcher(O, {
      [`${O}/`]: page(fixture('unknown-home.html')),
      [`${O}/en/men/1-hummingbird-printed-t-shirt.html`]: { status: 429, body: '' },
    });
    expect(await probeShop(f, O)).toMatchObject({ kind: 'rate_limited' });
    expect(f.requests).toHaveLength(6);
  });

  it('a Crawl-delay above 30 s needs setup, before the home page is read', async () => {
    const f = fakeFetcher(O, { [`${O}/`]: page(fixture('shopify-home.html')) }, { [O]: 'User-agent: *\nCrawl-delay: 45\n' });
    const d = await probeShop(f, O);
    expect(d).toMatchObject({ kind: 'unsupported', platform: null, reason: expect.stringMatching(/crawl delay too long for the check/i) });
    expect(d.robots).toMatchObject({ crawlDelaySeconds: 45 });
    expect(f.requests).toEqual([`${O}/robots.txt`]);
  });

  it('Magento: storeConfig works but the product list errors; Magento markers: falls back to pages', async () => {
    const f = fakeFetcher(O, {
      [`${O}/`]: page(fixture('magento-home.html')),
      [`${O}${PROBE_PATHS.magento}`]: page(fixture('magento-graphql.json')),
      [`${O}${magentoProductsPath(2)}`]: page(fixture('magento-products-error.json')),
    });
    expect(await probeShop(f, O)).toMatchObject({ kind: 'supported', platform: 'magento-html', adapter: 'magento', config: {} });
  });

  it('Magento: product list errors and no page markers: needs setup with the GraphQL error', async () => {
    const f = fakeFetcher(O, {
      [`${O}/`]: page(fixture('unknown-home.html')),
      [`${O}${PROBE_PATHS.magento}`]: page(fixture('magento-graphql.json')),
      [`${O}${magentoProductsPath(2)}`]: page(fixture('magento-products-error.json')),
    });
    const d = await probeShop(f, O);
    expect(d).toMatchObject({ kind: 'unsupported', platform: 'magento-graphql', reason: expect.stringMatching(/product list.*Internal server error/) });
    if (d.kind === 'unsupported') expect(d.details.graphqlError).toBe('Internal server error');
  });
});
