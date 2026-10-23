// Which product groups need a clean name: fresh site_products groups (Ruling R21: built within 2 days, shop active
// and not hidden) that were never normalised or whose title fingerprint changed. Also the pilot sample.
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { categorize } from '../site/categories.js';
import { loadSettings } from '../site/settings.js';
import type { BrandStatus } from './brand.js';

export type GroupInput = {
  shopId: number;
  shopSlug: string;
  groupKey: string;
  /** the shop's title of the group (site_products.title) */
  title: string;
  brand: string | null;
  /** site category slug: categorize() of today's rules (loadGroups), not the stored site_products.category */
  category: string;
  /** site_products.category as the last site build stored it */
  storedCategory?: string;
  categoryPath: string | null;
  gtin: string | null;
  mpn: string | null;
  /** distinct variant titles of the group's products */
  variantTitles: string[];
  /** product_names.title_hash of the last normalisation, null when never done */
  storedHash: string | null;
  /** whether brand names the maker (src/names/brand.ts); set by the CLI, judged from the brand text alone when missing */
  brandStatus?: BrandStatus;
  /** why the brand is unreliable or none */
  brandNote?: string | null;
};

/** Days a site_products row counts as fresh (Ruling R21, as FRESH_DAYS in src/site/build.ts). */
const FRESH_DAYS = 2;
/** Products seen within this many days give their variant titles (as SEEN_DAYS in src/site/build.ts). */
const SEEN_DAYS = 3;

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** sha256 of the normalised title plus the sorted normalised variant titles. */
export function titleHash(title: string, variantTitles: string[]): string {
  const variants = [...new Set(variantTitles.map(norm).filter((v) => v !== ''))].sort();
  return createHash('sha256').update([norm(title), ...variants].join('\n')).digest('hex');
}

/** Groups never normalised or whose title or variant titles changed since. */
export function changedGroups(groups: GroupInput[]): GroupInput[] {
  return groups.filter((g) => g.storedHash !== titleHash(g.title, g.variantTitles));
}

type GroupRow = {
  shop_id: number;
  shop_slug: string;
  group_key: string;
  title: string;
  brand: string | null;
  category: string;
  category_path: string | null;
  tags: string[] | null;
  shop_category: string | null;
  gtin: string | null;
  mpn: string | null;
  stored_hash: string | null;
};

/**
 * Fresh groups of active, visible shops (optionally only some categories), with their variant titles. The category
 * is recomputed with today's categorize() and the admin overrides (site_settings), as the next site build would set
 * it, so a rule fix applies before the build runs; the stored one is kept in storedCategory. The category inputs come
 * from the product site_products.rep_product_id points at (the build uses the group's representative, which is the
 * same product for most groups).
 */
export async function loadGroups(sql: postgres.Sql, opts: { categories?: string[] }): Promise<GroupInput[]> {
  const cats = opts.categories && opts.categories.length > 0 ? new Set(opts.categories) : null;
  const settings = await loadSettings(sql);
  const rows = await sql<GroupRow[]>`
    select sp.shop_id, s.slug as shop_slug, sp.group_key, sp.title, sp.brand, coalesce(sp.category, 'other') as category,
      p.category_path, p.tags, s.category as shop_category, sp.gtin, sp.mpn, pn.title_hash as stored_hash
    from site_products sp
    join shops s on s.id = sp.shop_id
    left join products p on p.id = sp.rep_product_id
    left join product_names pn on pn.shop_id = sp.shop_id and pn.group_key = sp.group_key
    where s.active and not s.site_hidden and sp.updated_at > now() - ${`${FRESH_DAYS} days`}::interval
    order by sp.shop_id, sp.group_key`;

  const groups: GroupInput[] = rows
    .map((r) => ({
      r,
      category: categorize({ categoryPath: r.category_path, tags: r.tags ?? [], title: r.title, shopCategory: r.shop_category }, settings.categoryOverrides),
    }))
    .filter(({ category }) => cats === null || cats.has(category))
    .map(({ r, category }) => ({
      shopId: r.shop_id,
      shopSlug: r.shop_slug,
      groupKey: r.group_key,
      title: r.title,
      brand: r.brand,
      category,
      storedCategory: r.category,
      categoryPath: r.category_path,
      gtin: r.gtin,
      mpn: r.mpn,
      variantTitles: [],
      storedHash: r.stored_hash,
    }));

  // variant titles, one query per shop (uses the (shop_id, external_id) index prefix)
  const byShop = new Map<number, Map<string, GroupInput>>();
  for (const g of groups) {
    let m = byShop.get(g.shopId);
    if (!m) byShop.set(g.shopId, (m = new Map()));
    m.set(g.groupKey, g);
  }
  for (const [shopId, byKey] of byShop) {
    const variants = await sql<{ group_key: string; variant_title: string }[]>`
      select coalesce(parent_external_id, external_id) as group_key, variant_title
      from products
      where shop_id = ${shopId} and last_seen > now() - ${`${SEEN_DAYS} days`}::interval
        and variant_title is not null and variant_title <> ''
      order by id`;
    for (const v of variants) {
      const g = byKey.get(v.group_key);
      if (g && !g.variantTitles.includes(v.variant_title)) g.variantTitles.push(v.variant_title);
    }
  }
  return groups;
}

function seededRandom(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  // mulberry32
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A spread sample of at most n groups: up to ceil(n / categories) per category, taken round-robin across the
 * category's shops (shop order and the groups within each shop shuffled with the seed), then the categories
 * interleaved so a cut at n keeps them balanced. Deterministic for a seed.
 */
export function pilotSample(groups: GroupInput[], n: number, seed: string): GroupInput[] {
  const byCat = new Map<string, GroupInput[]>();
  for (const g of groups) {
    const list = byCat.get(g.category);
    if (list) list.push(g);
    else byCat.set(g.category, [g]);
  }
  const cats = [...byCat.keys()].sort();
  if (cats.length === 0 || n <= 0) return [];
  const per = Math.ceil(n / cats.length);

  const picks: GroupInput[][] = cats.map((cat) => {
    const byShop = new Map<number, GroupInput[]>();
    for (const g of byCat.get(cat)!) {
      const list = byShop.get(g.shopId);
      if (list) list.push(g);
      else byShop.set(g.shopId, [g]);
    }
    const shopIds = shuffled([...byShop.keys()].sort((a, b) => a - b), seededRandom(`${seed}|${cat}`));
    const queues = shopIds.map((id) => shuffled(byShop.get(id)!.sort((a, b) => (a.groupKey < b.groupKey ? -1 : 1)), seededRandom(`${seed}|${cat}|${id}`)));
    const out: GroupInput[] = [];
    for (let round = 0; out.length < per; round++) {
      let took = false;
      for (const q of queues) {
        if (round < q.length && out.length < per) {
          out.push(q[round]);
          took = true;
        }
      }
      if (!took) break;
    }
    return out;
  });

  const result: GroupInput[] = [];
  for (let i = 0; result.length < n; i++) {
    let took = false;
    for (const list of picks) {
      if (i < list.length && result.length < n) {
        result.push(list[i]);
        took = true;
      }
    }
    if (!took) break;
  }
  return result;
}
