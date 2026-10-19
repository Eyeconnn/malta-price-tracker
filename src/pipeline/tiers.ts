import { readFileSync } from 'node:fs';
import { db } from '../db.js';

export interface AdaptiveConfig {
  intervals_hours: { normal: number; warm: number; hot: number };
  hot_window: { from: string; to: string };
  promotion: { warm_changes_7d: number; hot_changes_48h: number };
  category_warm_from: string;
  warm_shop_categories: string[];
  warm_category_pattern: string;
}

export const adaptive: AdaptiveConfig = JSON.parse(readFileSync('config/adaptive.json', 'utf8'));

/** Hours between checks per tier on a given date. Outside the hot window, hot products are checked like warm ones. */
export function intervalsOn(now: Date, cfg = adaptive) {
  const day = now.toISOString().slice(0, 10);
  const inHot = day >= cfg.hot_window.from && day <= cfg.hot_window.to;
  return { normal: cfg.intervals_hours.normal, warm: cfg.intervals_hours.warm, hot: inHot ? cfg.intervals_hours.hot : cfg.intervals_hours.warm };
}

/**
 * Recomputes watch_tier and next_check_at for products of one shop observed since `since`.
 * One price change in 7 days makes a product warm, two changes in 48 hours make it hot.
 * From category_warm_from, products in the configured categories are at least warm.
 * Zero and missing prices are left out of the change count.
 */
export async function updateTiers(shopId: number, since: Date, now = new Date()) {
  const iv = intervalsOn(now);
  const categoryRule = now.toISOString().slice(0, 10) >= adaptive.category_warm_from;
  const p = adaptive.promotion;
  await db()`
    with recent as (
      select po.product_id, po.observed_at, po.price_cents,
             lag(po.price_cents) over (partition by po.product_id order by po.observed_at) as prev
      from price_observations po
      join products pr on pr.id = po.product_id
      where pr.shop_id = ${shopId} and pr.last_seen >= ${since}
        and po.observed_at > ${now}::timestamptz - interval '8 days'
        and po.price_cents > 0
    ), changes as (
      select product_id,
             count(*) filter (where prev is not null and price_cents <> prev
                              and observed_at > ${now}::timestamptz - interval '7 days') as c7,
             count(*) filter (where prev is not null and price_cents <> prev
                              and observed_at > ${now}::timestamptz - interval '48 hours') as c48
      from recent group by product_id
    ), tiers as (
      select pr.id,
        case
          when coalesce(c.c48, 0) >= ${p.hot_changes_48h} then 'hot'
          when coalesce(c.c7, 0) >= ${p.warm_changes_7d} then 'warm'
          when ${categoryRule} and (
                 s.category = any(${adaptive.warm_shop_categories})
              or coalesce(pr.category_path, '') ~* ${adaptive.warm_category_pattern}
              or array_to_string(coalesce(pr.tags, '{}'), ' ') ~* ${adaptive.warm_category_pattern}) then 'warm'
          else 'normal'
        end as tier
      from products pr
      join shops s on s.id = pr.shop_id
      left join changes c on c.product_id = pr.id
      where pr.shop_id = ${shopId} and pr.last_seen >= ${since}
    )
    update products pr set
      watch_tier = t.tier,
      next_check_at = pr.last_seen + make_interval(hours => case t.tier
        when 'hot' then ${iv.hot}::int when 'warm' then ${iv.warm}::int else ${iv.normal}::int end)
    from tiers t where t.id = pr.id`;
}
