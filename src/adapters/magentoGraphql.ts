import type { CrawlContext, KnownProduct, NormalisedRecord } from '../types.js';
import { blankRecord, emptyToNull, toCents } from '../util/normalise.js';

// Magento 2 storefront GraphQL (public, read-only). Used when shop config has graphql: true and
// robots.txt allows /graphql (Intercomp). Root category id comes from config graphql_root (default 2).

const FIELDS = `__typename id sku name url_key url_suffix canonical_url stock_status
  image { url } categories { name }
  price_range { minimum_price { regular_price { value } final_price { value } }
                maximum_price { final_price { value } } }`;

interface GqlProduct {
  __typename: string;
  id: number;
  sku: string;
  name: string;
  url_key: string;
  url_suffix: string | null;
  canonical_url: string | null;
  stock_status: string;
  image: { url: string } | null;
  categories: { name: string }[] | null;
  price_range: {
    minimum_price: { regular_price: { value: number }; final_price: { value: number } };
    maximum_price: { final_price: { value: number } };
  };
}

function siteRoot(ctx: CrawlContext): string {
  return new URL(ctx.shop.base_url).origin;
}

async function query<T>(ctx: CrawlContext, gql: string): Promise<T> {
  // GET keeps it a plain public read; the query goes in the query string
  const url = `${siteRoot(ctx)}/graphql?query=${encodeURIComponent(gql.replace(/\s+/g, ' '))}`;
  const res = await ctx.fetcher.get(url, { accept: 'application/json' });
  if (res.status !== 200) throw new Error(`GraphQL HTTP ${res.status}`);
  const body = res.json<{ data?: T; errors?: { message: string }[] }>();
  if (body.errors?.length) throw new Error(`GraphQL: ${body.errors[0]!.message}`);
  return body.data as T;
}

export function gqlToRecord(p: GqlProduct, root: string): NormalisedRecord {
  const r = blankRecord(String(p.id));
  const path = p.canonical_url ?? `${p.url_key}${p.url_suffix ?? '.html'}`;
  r.url = path.startsWith('http') ? path : `${root}/${path.replace(/^\//, '')}`;
  r.sku = emptyToNull(p.sku);
  r.title = emptyToNull(p.name);
  r.category_path = p.categories?.length ? p.categories.map((c) => c.name).filter((n) => n !== 'Shop').join(' > ') || null : null;
  r.image_url = p.image?.url ?? null;
  const min = p.price_range.minimum_price;
  r.price_cents = toCents(min.final_price.value);
  const regular = toCents(min.regular_price.value);
  r.was_price_cents = regular !== null && r.price_cents !== null && regular > r.price_cents ? regular : null;
  r.on_sale = r.was_price_cents !== null;
  r.in_stock = p.stock_status === 'IN_STOCK' ? true : p.stock_status === 'OUT_OF_STOCK' ? false : null;
  const max = toCents(p.price_range.maximum_price.final_price.value);
  r.badge_text = max !== null && r.price_cents !== null && max !== r.price_cents ? 'price range' : null;
  r.meta = { sku: p.sku, type: p.__typename };
  return r;
}

/** The catalogue query the crawl uses (also sent with pageSize 1 by shop-request detection to prove it works). */
export function productsQuery(rootCat: string, pageSize: number, page: number): string {
  return `{ products(filter:{category_id:{eq:"${rootCat}"}}, pageSize:${pageSize}, currentPage:${page}, sort:{name:ASC}) {
     total_count page_info { total_pages } items { ${FIELDS} } } }`;
}

export async function* crawlGraphql(ctx: CrawlContext): AsyncGenerator<NormalisedRecord[]> {
  const root = siteRoot(ctx);
  const rootCat = String(ctx.shop.config.graphql_root ?? 2);
  const pageSize = Math.min(Number(ctx.shop.config.page_size ?? 100), 100);
  let produced = 0;
  for (let page = 1; page < 1000; page++) {
    const data = await query<{ products: { total_count: number; page_info: { total_pages: number }; items: GqlProduct[] } }>(ctx, productsQuery(rootCat, pageSize, page));
    const items = data.products.items;
    if (!items.length) break;
    const recs = items.map((p) => gqlToRecord(p, root));
    produced += recs.length;
    yield recs;
    ctx.log(`graphql page ${page}/${data.products.page_info.total_pages}: ${produced} of ${data.products.total_count}`);
    if (ctx.limit && produced >= ctx.limit) return;
    if (page >= data.products.page_info.total_pages) break;
  }
}

export async function fetchOneGraphql(ctx: CrawlContext, product: KnownProduct): Promise<NormalisedRecord[]> {
  const sku = product.meta.sku as string | undefined;
  if (!sku) return [];
  const data = await query<{ products: { items: GqlProduct[] } }>(
    ctx,
    `{ products(filter:{sku:{eq:${JSON.stringify(sku)}}}, pageSize:5) { items { ${FIELDS} } } }`,
  );
  return data.products.items.filter((p) => String(p.id) === product.external_id).map((p) => gqlToRecord(p, siteRoot(ctx)));
}
