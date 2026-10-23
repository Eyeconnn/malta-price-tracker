// Platform detection for a shop requested from the admin area: robots.txt, the home page, then at most one
// product-feed probe per supported platform (Shopify, WooCommerce Store API, Magento GraphQL), and for an
// unknown platform up to two product pages. About 7 requests, never more than about 10, all through the
// fetcher it is given (ShopFetcher in production: one at a time, 2 to 5 s apart, robots.txt and Crawl-delay
// obeyed, private addresses refused). Fetched content is data: only fixed markers and tags are read from it,
// and nothing in it can change what happens next beyond those markers.
import * as cheerio from 'cheerio';
import { DisallowedError, type FetchResult, HttpError, OutOfScopeError } from '../http/fetcher.js';
import type { RobotsRules } from '../http/robots.js';
import type { AdapterName, ShopConfig } from '../types.js';
import { hostKey } from './address.js';
import { siteNameFromHtml } from './naming.js';
import { type RobotsSummary, summariseRobots } from './robotsSummary.js';

/** What detection needs from a fetcher (ShopFetcher implements it). */
export interface ProbeFetcher {
  get(url: string, opts?: { accept?: string; retries?: number }): Promise<FetchResult>;
  robotsFor(url: string): Promise<RobotsRules>;
}

export type Platform = 'shopify' | 'woocommerce' | 'magento-graphql' | 'magento-html' | 'unknown';
type Probe = 'shopify' | 'woo' | 'magento';

const GRAPHQL_QUERY = '{storeConfig{store_code root_category_id}}';

/** The one request per platform that proves it (path and query, appended to the shop's origin). */
export const PROBE_PATHS: Record<Probe, string> = {
  shopify: '/products.json?limit=1',
  woo: '/wp-json/wc/store/v1/products?per_page=1',
  magento: `/graphql?query=${encodeURIComponent(GRAPHQL_QUERY)}`,
};
/** The feed path robots.txt is checked against, as shown on the request. */
const FEED_PATHS: Record<Probe, string> = { shopify: '/products.json', woo: '/wp-json/wc/store/v1/products', magento: '/graphql' };
const FEED_NAMES: Record<Probe, string> = { shopify: 'Shopify', woo: 'WooCommerce', magento: 'Magento GraphQL' };
const PROBE_PLATFORM: Record<Probe, Platform> = { shopify: 'shopify', woo: 'woocommerce', magento: 'magento-graphql' };

/** What was found on a shop the scraper cannot read yet, for a later session to configure by hand. */
export interface SetupDetails {
  server: string | null;
  poweredBy: string | null;
  /** <meta name="generator"> values on the home page */
  generator: string[];
  /** JSON-LD Product data on the product pages checked; null when none could be checked */
  jsonLdProduct: boolean | null;
  /** paths of the product pages read */
  productPagesChecked: string[];
  /** a few category or menu links from the home page (paths) */
  categoryLinks: string[];
  /** product feeds robots.txt does not allow */
  disallowed: { feed: string; path: string; rule: string }[];
}

export type Detection =
  | { kind: 'supported'; platform: Platform; adapter: AdapterName; config: ShopConfig; baseUrl: string; siteName: string | null; robots: RobotsSummary }
  | { kind: 'blocked'; platform: Platform | null; reason: string; robots: RobotsSummary }
  | { kind: 'unsupported'; platform: 'unknown'; baseUrl: string; siteName: string | null; details: SetupDetails; robots: RobotsSummary }
  | { kind: 'unreachable'; reason: string; robots: RobotsSummary | null };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Shopify's /products.json: { products: [{ variants: [...] }] } */
export function looksLikeShopifyProducts(body: unknown): boolean {
  if (!isObject(body) || !Array.isArray(body.products) || body.products.length === 0) return false;
  const p = body.products[0];
  return isObject(p) && Array.isArray(p.variants) && 'handle' in p;
}

/** WooCommerce Store API /products: [{ id, prices: {...} }] */
export function looksLikeWooProducts(body: unknown): boolean {
  if (!Array.isArray(body) || body.length === 0) return false;
  const p = body[0];
  return isObject(p) && 'id' in p && isObject(p.prices);
}

/** Magento storefront GraphQL answer to the storeConfig query; root is the root category id when given. */
export function magentoGraphqlRoot(body: unknown): { ok: boolean; root: number | null } {
  if (!isObject(body) || (Array.isArray(body.errors) && body.errors.length) || !isObject(body.data) || !isObject(body.data.storeConfig)) {
    return { ok: false, root: null };
  }
  const root = Number(body.data.storeConfig.root_category_id);
  return { ok: true, root: Number.isInteger(root) && root > 0 ? root : null };
}

const clip = (s: string | null | undefined, n = 100): string | null => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, n) : null;
};

/** Platform hints on the home page and in its headers. They only order the probes; a probe decides. */
export function htmlHints(html: string, headers: Headers): { shopify: boolean; woo: boolean; magento: boolean; generator: string[] } {
  const $ = cheerio.load(html);
  const generator = $('meta[name="generator"]')
    .map((_, el) => clip($(el).attr('content')))
    .get()
    .filter((g): g is string => !!g)
    .slice(0, 5);
  const headerNames = [...headers.keys()];
  return {
    shopify:
      headers.has('x-shopid') ||
      headers.has('x-shopify-stage') ||
      /shopify/i.test(headers.get('powered-by') ?? '') ||
      /cdn\.shopify\.com|Shopify\.theme|myshopify\.com/.test(html),
    woo: /woocommerce/i.test(html) || generator.some((g) => /woocommerce/i.test(g)),
    magento: headerNames.some((h) => h.startsWith('x-magento')) || /mage-init|text\/x-magento-init|Magento_/.test(html),
    generator,
  };
}

function typesOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(typesOf);
  if (!isObject(node)) return [];
  const t = node['@type'];
  const own = Array.isArray(t) ? t.map(String) : t === undefined ? [] : [String(t)];
  return [...own, ...typesOf(node['@graph'])];
}

/** True when a JSON-LD block on the page describes a Product (also inside @graph). */
export function hasJsonLdProduct(html: string): boolean {
  const $ = cheerio.load(html);
  return $('script[type="application/ld+json"]')
    .toArray()
    .some((el) => {
      try {
        return typesOf(JSON.parse($(el).text())).includes('Product');
      } catch {
        return false;
      }
    });
}

/** Same-shop links on the home page: up to two that look like product pages, up to five category or menu links. */
function pageLinks(html: string, base: string): { products: string[]; categories: string[] } {
  const $ = cheerio.load(html);
  const scope = hostKey(base);
  const resolve = (href: string | undefined): string | null => {
    if (!href) return null;
    try {
      const u = new URL(href, base);
      if ((u.protocol !== 'https:' && u.protocol !== 'http:') || hostKey(u.hostname) !== scope) return null;
      const path = `${u.pathname}${u.search}`;
      return path === '/' ? null : path.slice(0, 200);
    } catch {
      return null;
    }
  };
  const productLike = (p: string) => /\/(product|products|p|item|items)\/[^/]+/i.test(p) || /\.html?$/i.test(new URL(p, base).pathname);
  const products: string[] = [];
  const categories: string[] = [];
  $('a[href]').each((_, el) => {
    const path = resolve($(el).attr('href'));
    if (!path) return;
    if (productLike(path)) {
      if (products.length < 2 && !products.includes(path)) products.push(path);
      return;
    }
    const inNav = $(el).closest('nav, header').length > 0;
    if ((inNav || /categor|collection|department|\/c\//i.test(path)) && categories.length < 5 && !categories.includes(path)) categories.push(path);
  });
  return { products, categories };
}

function describeFailure(e: unknown, what: string): string {
  if (e instanceof OutOfScopeError) {
    let host = e.url;
    try {
      host = new URL(e.url).hostname;
    } catch {
      // keep the url
    }
    return `${what} redirects to another site (${host}). If that is the same shop, add that address instead.`;
  }
  if (e instanceof HttpError) {
    const blocking = [202, 401, 403, 429].includes(e.status) ? ' The shop may block automated visitors; that is not worked around.' : '';
    return `${what} could not be read (HTTP ${e.status}).${blocking}`;
  }
  return `${what} could not be read: ${(e as Error).message}`.slice(0, 300);
}

export async function probeShop(f: ProbeFetcher, origin: string, log: (m: string) => void = () => {}): Promise<Detection> {
  const homeUrl = `${origin}/`;
  const rules = await f.robotsFor(homeUrl);
  if (rules.status === 'unreachable') {
    return { kind: 'blocked', platform: null, reason: 'robots.txt could not be read (server errors), so the shop counts as closed to crawlers. Retry later.', robots: summariseRobots(rules, origin, ['/']) };
  }
  if (!rules.isAllowed(homeUrl)) {
    const robots = summariseRobots(rules, origin, ['/']);
    return { kind: 'blocked', platform: null, reason: `robots.txt blocks the home page: ${robots.blockedBy!.rule}`, robots };
  }

  let home: FetchResult;
  try {
    home = await f.get(homeUrl, { accept: 'text/html,application/xhtml+xml', retries: 1 });
  } catch (e) {
    if (e instanceof DisallowedError) {
      return { kind: 'blocked', platform: null, reason: `robots.txt blocks the page the home page redirects to (${e.url.slice(0, 200)}).`, robots: summariseRobots(rules, origin, ['/']) };
    }
    return { kind: 'unreachable', reason: describeFailure(e, 'The home page'), robots: summariseRobots(rules, origin, ['/']) };
  }
  if (home.status !== 200) return { kind: 'unreachable', reason: `The home page could not be read (HTTP ${home.status}).`, robots: summariseRobots(rules, origin, ['/']) };

  // a redirect within the shop (apex to www.) moves the base address
  const base = new URL(home.url).origin;
  const baseRules = base === origin ? rules : await f.robotsFor(`${base}/`);
  const html = home.text();
  const hints = htmlHints(html, home.headers);
  const siteName = siteNameFromHtml(html);
  log(`home page read; hints: ${(['shopify', 'woo', 'magento'] as const).filter((k) => hints[k]).join(', ') || 'none'}`);

  const order = (['shopify', 'woo', 'magento'] as const).slice().sort((a, b) => Number(hints[b]) - Number(hints[a]));
  const disallowed: SetupDetails['disallowed'] = [];
  for (const probe of order) {
    const url = `${base}${PROBE_PATHS[probe]}`;
    if (!baseRules.isAllowed(url)) {
      disallowed.push({ feed: FEED_NAMES[probe], path: FEED_PATHS[probe], rule: baseRules.blockingRule(url) ?? 'disallowed' });
      continue;
    }
    let body: unknown;
    try {
      const res = await f.get(url, { accept: 'application/json', retries: 1 });
      if (res.status !== 200) continue;
      body = res.json();
    } catch (e) {
      log(`${FEED_NAMES[probe]} probe: ${(e as Error).message}`);
      continue;
    }
    const robots = summariseRobots(baseRules, base, ['/', FEED_PATHS[probe]]);
    const supported = (adapter: AdapterName, config: ShopConfig): Detection => ({ kind: 'supported', platform: PROBE_PLATFORM[probe], adapter, config, baseUrl: base, siteName, robots });
    if (probe === 'shopify' && looksLikeShopifyProducts(body)) return supported('shopify', {});
    if (probe === 'woo' && looksLikeWooProducts(body)) return supported('woo', {});
    if (probe === 'magento') {
      const gql = magentoGraphqlRoot(body);
      if (gql.ok) return supported('magento', gql.root !== null ? { graphql: true, graphql_root: gql.root } : { graphql: true });
    }
  }

  if (hints.magento) {
    return { kind: 'supported', platform: 'magento-html', adapter: 'magento', config: {}, baseUrl: base, siteName, robots: summariseRobots(baseRules, base, ['/']) };
  }

  const hinted = order.map((p) => ({ p, d: disallowed.find((x) => x.feed === FEED_NAMES[p]) })).find((x) => hints[x.p] && x.d);
  if (hinted?.d) {
    return {
      kind: 'blocked',
      platform: PROBE_PLATFORM[hinted.p],
      reason: `robots.txt blocks the ${FEED_NAMES[hinted.p]} product feed: ${hinted.d.rule}`,
      robots: summariseRobots(baseRules, base, ['/', hinted.d.path]),
    };
  }

  // unknown platform: look at up to two product pages for JSON-LD Product data
  const links = pageLinks(html, base);
  const checked: string[] = [];
  let jsonLd: boolean | null = null;
  for (const path of links.products) {
    const url = new URL(path, base).toString();
    if (!baseRules.isAllowed(url)) continue;
    try {
      const res = await f.get(url, { accept: 'text/html', retries: 1 });
      if (res.status !== 200) continue;
      checked.push(path);
      jsonLd = jsonLd === true || hasJsonLdProduct(res.text());
    } catch (e) {
      log(`product page ${path}: ${(e as Error).message}`);
    }
  }
  return {
    kind: 'unsupported',
    platform: 'unknown',
    baseUrl: base,
    siteName,
    details: {
      server: clip(home.headers.get('server')),
      poweredBy: clip(home.headers.get('x-powered-by')),
      generator: hints.generator,
      jsonLdProduct: jsonLd,
      productPagesChecked: checked,
      categoryLinks: links.categories,
      disallowed,
    },
    robots: summariseRobots(baseRules, base, ['/']),
  };
}
