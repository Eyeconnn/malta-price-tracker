// Reads of the judge and the site build: fresh listings of visible shops (Rulings R21 and R28) with what the judge
// sends Claude, and the variant titles the fingerprint covers (one query per shop, as src/names/select.ts).
import type postgres from 'postgres';
import type { Listing } from './candidates.js';
import { memberRef } from './fingerprint.js';

/** Days a site_products row counts as fresh (Ruling R21, as FRESH_DAYS in src/site/build.ts). */
const FRESH_DAYS = 2;
/** Products seen within this many days give their variant titles (as SEEN_DAYS in src/site/build.ts). */
const SEEN_DAYS = 3;

type Row = {
  id: string;
  shop_id: number;
  shop_slug: string;
  group_key: string;
  title: string;
  brand: string | null;
  category: string;
  category_path: string | null;
  gtin: string | null;
  mpn: string | null;
  price_cents: number | null;
  canonical_id: string | null;
  match_method: string | null;
  display_name: string | null;
  attrs: Record<string, unknown> | null;
};

/**
 * The variant titles of groups, by member ref (shop id and group key): every product of the group seen within
 * SEEN_DAYS with a non-empty variant title. keys: per shop, only these group keys (the site build); null: all.
 */
export async function loadVariantTitles(sql: postgres.Sql, keys: Map<number, string[]> | null, shopIds: number[] = []): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const shops = keys ? [...keys.keys()] : shopIds;
  for (const shopId of shops) {
    const only = keys?.get(shopId);
    if (only && only.length === 0) continue;
    const rows = await sql<{ group_key: string; variant_title: string }[]>`
      select coalesce(parent_external_id, external_id) as group_key, variant_title
      from products
      where shop_id = ${shopId} and last_seen > now() - ${`${SEEN_DAYS} days`}::interval
        and variant_title is not null and variant_title <> ''
        ${only ? sql`and coalesce(parent_external_id, external_id) = any(${only}::text[])` : sql``}
      order by id`;
    for (const r of rows) {
      const ref = memberRef({ shopId, groupKey: r.group_key });
      const list = out.get(ref);
      if (!list) out.set(ref, [r.variant_title]);
      else if (!list.includes(r.variant_title)) list.push(r.variant_title);
    }
  }
  return out;
}

/** Fresh site_products rows of active, visible shops, with variant titles, accepted clean names and the last match. */
export async function loadListings(sql: postgres.Sql): Promise<Listing[]> {
  const rows = await sql<Row[]>`
    select sp.id, sp.shop_id, s.slug as shop_slug, sp.group_key, sp.title, sp.brand, coalesce(sp.category, 'other') as category,
      p.category_path, sp.gtin, sp.mpn, sp.price_cents, sp.canonical_id, sp.match_method, pn.display_name, pn.attrs
    from site_products sp
    join shops s on s.id = sp.shop_id
    left join products p on p.id = sp.rep_product_id
    left join product_names pn on pn.shop_id = sp.shop_id and pn.group_key = sp.group_key
      and pn.status = 'ok' and pn.display_name is not null and pn.source_title = sp.title
    where s.active and not s.site_hidden and sp.updated_at > now() - ${`${FRESH_DAYS} days`}::interval
    order by sp.id`;
  const variants = await loadVariantTitles(sql, null, [...new Set(rows.map((r) => r.shop_id))]);
  return rows.map((r) => ({
    id: Number(r.id),
    shopId: r.shop_id,
    shopSlug: r.shop_slug,
    groupKey: r.group_key,
    title: r.title,
    brand: r.brand,
    category: r.category,
    categoryPath: r.category_path,
    gtin: r.gtin,
    mpn: r.mpn,
    priceCents: r.price_cents,
    variantTitles: variants.get(memberRef({ shopId: r.shop_id, groupKey: r.group_key })) ?? [],
    cleanName: r.display_name,
    attrs: r.attrs,
    canonicalId: r.canonical_id,
    matchMethod: r.match_method,
  }));
}
