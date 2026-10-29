import type { ShopFetcher } from './http/fetcher.js';

export type AdapterName = 'woo' | 'shopify' | 'magento' | 'html' | 'headless' | 'snapshot';

/** One product variant as every adapter returns it. Prices are integer euro cents. */
export interface NormalisedRecord {
  external_id: string;
  parent_external_id?: string | null;
  url: string | null;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  brand: string | null;
  title: string | null;
  variant_title: string | null;
  category_path: string | null;
  tags: string[];
  image_url: string | null;
  shop_created_at: string | null;
  price_cents: number | null;
  was_price_cents: number | null;
  /**
   * where was_price_cents came from (migration 015): 'feed' the feed's regular / compare-at price, 'shown' the price
   * the shop shows struck through (config.shown_was). Unset: the adapter does not say.
   */
  was_source?: 'feed' | 'shown';
  /** with was_source 'shown': the feed's own regular price above the price, for audit */
  feed_was_price_cents?: number | null;
  shop_30d_low_cents: number | null;
  in_stock: boolean | null;
  on_sale: boolean | null;
  badge_text: string | null;
  /** adapter data needed to re-read this product cheaply later (handle, parent id, ...) */
  meta?: Record<string, unknown>;
}

export interface ShopConfig {
  /** milliseconds between requests to this shop; robots Crawl-delay wins if longer */
  min_delay_ms?: number;
  max_delay_ms?: number;
  timeout_ms?: number;
  page_size?: number;
  max_requests_per_hour?: number;
  /** consecutive failed requests before the shop run is abandoned */
  max_consecutive_failures?: number;
  /** extra paths we never fetch, on top of robots.txt (regex strings) */
  extra_disallow?: string[];
  /** copy 12/13/14 digit numeric SKUs into gtin */
  sku_is_gtin?: boolean;
  /** regex with one capture group, applied to SKU to extract an MPN */
  mpn_from_sku?: string;
  /**
   * "browser": HTML pages are rendered in a headless browser (Crawl4AI, src/http/renderer.ts) for shops whose
   * products only appear after JavaScript runs. Needs the renderer installed, so such a shop runs on the PC (runner local).
   */
  render?: 'browser';
  /** with render "browser": a CSS selector to wait for before the page is read (e.g. the product grid) */
  render_wait_for?: string;
  /**
   * with render "browser": a "Load more" button on listing pages, clicked at the shop's own pace (one click per gap,
   * each counted as a request) until it is gone or adds no `items` (a CSS selector for the product tiles)
   */
  render_load_more?: { button: string; items: string; max_clicks?: number };
  /** with render "browser": only HTML pages whose address matches this regex are rendered (e.g. listing pages) */
  render_urls?: string;
  /** adapter specific settings (selectors etc.) */
  [key: string]: unknown;
}

export interface Shop {
  id: number;
  slug: string;
  name: string;
  base_url: string;
  category: string | null;
  adapter: AdapterName;
  config: ShopConfig;
  tier: 'P1' | 'P2' | 'P3';
  active: boolean;
}

/** What a product row looks like when an adapter has to re-read it on its own. */
export interface KnownProduct {
  id: number;
  external_id: string;
  parent_external_id: string | null;
  url: string | null;
  meta: Record<string, unknown>;
}

export interface CrawlContext {
  shop: Shop;
  fetcher: ShopFetcher;
  /** stop after this many records (testing) */
  limit?: number;
  log: (msg: string) => void;
  /** record a non-fatal problem; counted in scrape_runs.errors */
  error: (msg: string) => void;
  /**
   * Which of these external ids still need a product-page read (no identifiers stored yet).
   * Without a database (dry runs) every id needs one.
   */
  needsDetail?: (externalIds: string[]) => Promise<Set<string>>;
}

export interface Adapter {
  /** Walk the whole catalogue, yielding normalised records as they are found. */
  crawl(ctx: CrawlContext): AsyncGenerator<NormalisedRecord[]>;
  /** Re-read one product cheaply. Returns every variant record found for it. */
  fetchOne(ctx: CrawlContext, product: KnownProduct): Promise<NormalisedRecord[]>;
}
