import { createHash } from 'node:crypto';
import { db } from '../db.js';
import type { NormalisedRecord, Shop } from '../types.js';
import { detectBlackFriday } from '../util/blackfriday.js';

export interface FlaggedRow {
  product_id: number;
  external_id: string;
  title: string | null;
  url: string | null;
  flag: string;
  price_cents: number | null;
  prev_price_cents: number | null;
}

export async function startRun(shopId: number, kind: 'full' | 'due'): Promise<number> {
  const [row] = await db()<{ id: number }[]>`
    insert into scrape_runs (shop_id, kind) values (${shopId}, ${kind}) returning id`;
  return Number(row!.id);
}

export interface RunTotals {
  status: 'ok' | 'partial' | 'failed';
  products_seen: number;
  requests: number;
  failed_requests: number;
  disallowed: number;
  errors: number;
  error_log: string[];
  notes: string | null;
}

export async function finishRun(runId: number, t: RunTotals) {
  await db()`
    update scrape_runs set
      finished_at = now(), status = ${t.status}, products_seen = ${t.products_seen},
      requests = ${t.requests}, failed_requests = ${t.failed_requests}, disallowed = ${t.disallowed},
      errors = ${t.errors}, error_log = ${db().json(t.error_log.slice(0, 100))}, notes = ${t.notes}
    where id = ${runId}`;
}

/** Runs that started more than `hours` ago and never finished: mark failed so they show up in alerts. */
export async function closeStaleRuns(hours = 7): Promise<{ id: number; slug: string; started_at: Date }[]> {
  return db()<{ id: number; slug: string; started_at: Date }[]>`
    update scrape_runs r set status = 'failed', finished_at = now(),
      notes = coalesce(r.notes || ' ', '') || 'run did not finish (process died or timed out)'
    from shops s
    where s.id = r.shop_id and r.finished_at is null and r.started_at < now() - make_interval(hours => ${hours})
    returning r.id, s.slug, r.started_at`;
}

export async function shopHasRunningRun(shopId: number, hours = 7): Promise<boolean> {
  const rows = await db()`
    select 1 from scrape_runs where shop_id = ${shopId} and finished_at is null
      and started_at > now() - make_interval(hours => ${hours}) limit 1`;
  return rows.length > 0;
}

function obsHash(r: NormalisedRecord): string {
  const key = [r.price_cents, r.was_price_cents, r.shop_30d_low_cents, r.in_stock, r.on_sale, r.badge_text].join('|');
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

export function reviewFlag(price: number | null, prev: number | null, inStock: boolean | null = null): string | null {
  // some shops hide the price of out-of-stock products; that is not a data problem
  if (price === null) return inStock === false ? null : 'missing_price';
  if (price === 0) return 'zero_price';
  if (prev !== null && prev > 0 && Math.abs(price - prev) / prev > 0.7) return 'jump_70pct';
  return null;
}

/**
 * Upserts products (refreshing last_seen) and inserts one price observation per product.
 * Records flagged `meta.partial` (e.g. a Woo variation re-read on its own) do not overwrite
 * descriptive fields such as title, tags or categories.
 */
export async function saveBatch(
  shop: Shop,
  runId: number,
  records: NormalisedRecord[],
  observedAt: Date,
): Promise<{ saved: number; flagged: FlaggedRow[] }> {
  if (records.length === 0) return { saved: 0, flagged: [] };
  const sql = db();
  const productRows = records.map((r) => {
    const partial = Boolean(r.meta?.partial);
    const meta = { ...(r.meta ?? {}) };
    delete meta.partial;
    delete meta.no_bf;
    delete meta.bf_collection;
    return {
      external_id: r.external_id,
      parent_external_id: r.parent_external_id ?? null,
      url: r.url,
      sku: r.sku,
      gtin: r.gtin,
      mpn: r.mpn,
      brand: partial ? null : r.brand,
      title: partial ? null : r.title,
      variant_title: r.variant_title,
      category_path: partial ? null : r.category_path,
      tags: partial ? null : r.tags,
      image_url: partial ? null : r.image_url,
      shop_created_at: r.shop_created_at,
      meta,
    };
  });

  const ids = await sql<{ id: string; external_id: string }[]>`
    insert into products as p (shop_id, external_id, parent_external_id, url, sku, gtin, mpn, brand, title,
      variant_title, category_path, tags, image_url, shop_created_at, meta, first_seen, last_seen)
    select ${shop.id}, x.external_id, x.parent_external_id, x.url, x.sku, x.gtin, x.mpn, x.brand, x.title,
      x.variant_title, x.category_path, x.tags, x.image_url, x.shop_created_at,
      coalesce(x.meta, '{}'::jsonb), ${observedAt}, ${observedAt}
    from jsonb_to_recordset(${sql.json(productRows as never)}) as x(
      external_id text, parent_external_id text, url text, sku text, gtin text, mpn text, brand text,
      title text, variant_title text, category_path text, tags text[], image_url text,
      shop_created_at timestamptz, meta jsonb)
    on conflict (shop_id, external_id) do update set
      parent_external_id = coalesce(excluded.parent_external_id, p.parent_external_id),
      url = coalesce(excluded.url, p.url),
      sku = coalesce(excluded.sku, p.sku),
      gtin = coalesce(excluded.gtin, p.gtin),
      mpn = coalesce(excluded.mpn, p.mpn),
      brand = coalesce(excluded.brand, p.brand),
      title = coalesce(excluded.title, p.title),
      variant_title = coalesce(excluded.variant_title, p.variant_title),
      category_path = coalesce(excluded.category_path, p.category_path),
      tags = coalesce(excluded.tags, p.tags),
      image_id = case when excluded.image_url is not null and excluded.image_url is distinct from p.image_url
                      then null else p.image_id end,
      image_url = coalesce(excluded.image_url, p.image_url),
      shop_created_at = coalesce(excluded.shop_created_at, p.shop_created_at),
      meta = p.meta || excluded.meta,
      last_seen = excluded.last_seen
    returning id, external_id`;

  const idByExt = new Map(ids.map((r) => [r.external_id, Number(r.id)]));
  const productIds = [...idByExt.values()];

  const prevRows = await sql<{ product_id: string; price_cents: number | null }[]>`
    select distinct on (product_id) product_id, price_cents
    from price_observations
    where product_id in ${sql(productIds)} and observed_at < ${observedAt}
    order by product_id, observed_at desc`;
  const prev = new Map(prevRows.map((r) => [Number(r.product_id), r.price_cents]));

  // Black Friday marker: tags, categories, collections and badges (partial re-reads carry none, so skip them)
  const bf = new Map<number, ReturnType<typeof detectBlackFriday>>();
  for (const r of records) if (!r.meta?.partial && !r.meta?.no_bf) bf.set(idByExt.get(r.external_id)!, detectBlackFriday(r));
  await updateBlackFriday(shop, bf, observedAt);

  const flagged: FlaggedRow[] = [];
  const obsRows = records.map((r) => {
    const pid = idByExt.get(r.external_id)!;
    const before = prev.get(pid) ?? null;
    const flag = reviewFlag(r.price_cents, before, r.in_stock);
    if (flag) {
      flagged.push({
        product_id: pid,
        external_id: r.external_id,
        title: r.title,
        url: r.url,
        flag,
        price_cents: r.price_cents,
        prev_price_cents: before,
      });
    }
    return {
      product_id: pid,
      price_cents: r.price_cents,
      was_price_cents: r.was_price_cents && r.was_price_cents > 0 ? r.was_price_cents : null,
      was_source: r.was_source ?? null,
      feed_was_price_cents: r.feed_was_price_cents && r.feed_was_price_cents > 0 ? r.feed_was_price_cents : null,
      shop_30d_low_cents: r.shop_30d_low_cents,
      in_stock: r.in_stock,
      on_sale: r.on_sale,
      badge_text: r.badge_text,
      raw_hash: obsHash(r),
      review_flag: flag,
      bf_marked: bf.has(pid) ? bf.get(pid)?.status === 'marked' : null,
    };
  });

  await sql`
    insert into price_observations (product_id, observed_at, run_id, price_cents, was_price_cents, was_source,
      feed_was_price_cents, shop_30d_low_cents, in_stock, on_sale, badge_text, raw_hash, review_flag, bf_marked)
    select x.product_id, ${observedAt}, ${runId}, x.price_cents, x.was_price_cents, x.was_source, x.feed_was_price_cents,
      x.shop_30d_low_cents, x.in_stock, x.on_sale, x.badge_text, x.raw_hash, x.review_flag, x.bf_marked
    from jsonb_to_recordset(${sql.json(obsRows as never)}) as x(
      product_id bigint, price_cents integer, was_price_cents integer, was_source text, feed_was_price_cents integer,
      shop_30d_low_cents integer, in_stock boolean, on_sale boolean, badge_text text, raw_hash text, review_flag text,
      bf_marked boolean)
    on conflict (product_id, observed_at) do nothing`;

  return { saved: obsRows.length, flagged };
}

/** External ids that are new or have never had a product-page read (meta.detailed not set). */
export async function idsNeedingDetail(shopId: number, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const done = await db()<{ external_id: string }[]>`
    select external_id from products
    where shop_id = ${shopId} and external_id in ${db()(ids)} and (meta->>'detailed') is not null`;
  const have = new Set(done.map((r) => r.external_id));
  return new Set(ids.filter((id) => !have.has(id)));
}

/**
 * Writes each product's Black Friday status. first/last marked dates move only while a current
 * marker is present. A marker already there when the product was first seen, during the shop's
 * first two days of tracking, is "preexisting": its real start date is unknown.
 * Only rows whose status changes, or that are marked (their last date moves), are rewritten.
 */
async function updateBlackFriday(shop: Shop, bf: Map<number, ReturnType<typeof detectBlackFriday>>, observedAt: Date) {
  const rows = [...bf].map(([id, r]) => ({ id, bf_status: r?.status ?? null, bf_marker: r?.marker ?? null }));
  if (!rows.length) return;
  const sql = db();
  await sql`
    update products p set
      bf_status = x.bf_status,
      bf_marker = x.bf_marker,
      bf_first_marked_at = case when x.bf_status = 'marked' then coalesce(p.bf_first_marked_at, ${observedAt}::timestamptz)
                                else p.bf_first_marked_at end,
      bf_last_marked_at = case when x.bf_status = 'marked' then ${observedAt}::timestamptz else p.bf_last_marked_at end,
      bf_preexisting = case
        when x.bf_status = 'marked' and p.bf_first_marked_at is null then
          p.first_seen > ${observedAt}::timestamptz - interval '6 hours'
          and p.first_seen < coalesce((select min(started_at) from scrape_runs where shop_id = ${shop.id}), now()) + interval '2 days'
        else p.bf_preexisting end
    from jsonb_to_recordset(${sql.json(rows as never)}) as x(id bigint, bf_status text, bf_marker text)
    where p.id = x.id
      and (x.bf_status = 'marked' or p.bf_status is distinct from x.bf_status or p.bf_marker is distinct from x.bf_marker)`;
}

/** Shop ids with an ok or partial full run that started within the last `hours`. */
export async function recentlyScraped(shopIds: number[], hours: number): Promise<number[]> {
  if (!shopIds.length) return [];
  const rows = await db()<{ shop_id: number }[]>`
    select distinct shop_id from scrape_runs
    where shop_id in ${db()(shopIds)} and kind = 'full' and status in ('ok', 'partial')
      and started_at > now() - make_interval(hours => ${hours})`;
  return rows.map((r) => Number(r.shop_id));
}
