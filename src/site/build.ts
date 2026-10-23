// Nightly site build: turns raw scraped prices into site_products (one row per product group per shop),
// verdicts history rows, canonical ids across shops and shop_ratings. One shop at a time, groups in
// batches, so only a slice of the observations is ever in memory.
import type postgres from 'postgres';
import { judgedClusters, type Resolved } from '../match/apply.js';
import { categorize } from './categories.js';
import { assignMatches, type Match, type MatchInput, nameMatch } from './matching.js';
import { computeRating, JUDGED_SQL } from './rating.js';
import type { SiteSettings } from './settings.js';
import { computeVerdict, type Obs, type Verdict } from './verdict.js';

const DAY_MS = 86_400_000;
/** Products seen within this many days are built. */
const SEEN_DAYS = 3;
/** Groups with no variant seen within this many days are deleted. */
const KEEP_DAYS = 7;
const GROUP_BATCH = 2000;
const WRITE_BATCH = 5000;

export type ProductRow = {
  id: string;
  group_key: string;
  url: string | null;
  gtin: string | null;
  mpn: string | null;
  brand: string | null;
  title: string | null;
  category_path: string | null;
  tags: string[] | null;
  image_url: string | null;
  bf_status: string | null;
};

export type ObsRow = {
  product_id: string;
  observed_at: Date;
  price_cents: number | null;
  was_price_cents: number | null;
  in_stock: boolean | null;
  bf_marked: boolean | null;
};

export type VariantResult = { product: ProductRow; latest: Obs | null; verdict: Verdict };

export type Shop = { id: number; slug: string; category: string | null };

type GroupRow = {
  group_key: string;
  title: string;
  brand: string | null;
  url: string | null;
  image_url: string | null;
  category: string;
  variant_count: number;
  rep_product_id: string;
  gtin: string | null;
  mpn: string | null;
  price_cents: number | null;
  was_price_cents: number | null;
  in_stock: boolean | null;
  bf_status: string | null;
  verdict: Verdict['label'];
  reason: string;
  facts: Verdict['facts'];
};

/** Observation for the verdict engine. bf: the night's bf_marked; older rows without it use the product's bf_status. */
export function toObs(row: Omit<ObsRow, 'product_id'>, productBfStatus: string | null): Obs {
  return {
    at: row.observed_at,
    price: row.price_cents,
    was: row.was_price_cents,
    inStock: row.in_stock,
    bf: row.bf_marked ?? productBfStatus === 'marked',
  };
}

const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const priceOf = (v: VariantResult) => (positive(v.latest?.price) ? (v.latest!.price as number) : null);
const inStock = (v: VariantResult) => v.latest?.inStock === true;

/** Cheapest by latest price (no price sorts last); ties keep input order. */
function cheapest(vs: VariantResult[]): VariantResult {
  let best = vs[0];
  for (const v of vs.slice(1)) {
    const p = priceOf(v);
    const bp = priceOf(best);
    if (p !== null && (bp === null || p < bp)) best = v;
  }
  return best;
}

/** Cheapest in-stock variant with a positive price, else the cheapest variant, else the first. */
export function pickRepresentative(vs: VariantResult[]): VariantResult {
  const pricedInStock = vs.filter((v) => inStock(v) && priceOf(v) !== null);
  return cheapest(pricedInStock.length > 0 ? pricedInStock : vs);
}

const RANK: Record<Verdict['label'], number> = { avoid: 3, good: 2, none: 1, insufficient: 0 };

/** Relative size of the rise behind an avoid: the price rise, else the was price rise, else 0. */
function riseOf(v: VariantResult): number {
  const f = v.verdict.facts;
  if (f.raisedFrom && f.raisedTo) return (f.raisedTo.price - f.raisedFrom.price) / f.raisedFrom.price;
  const was = v.latest?.was;
  if (positive(f.wasRaisedFrom) && positive(was)) return (was - f.wasRaisedFrom) / f.wasRaisedFrom;
  return 0;
}

/**
 * The variant whose verdict the group shows: the worst label among in-stock variants (all variants when
 * none is in stock). Among avoids the largest rise wins; otherwise judged variants first, then the representative,
 * else the cheapest.
 */
export function pickVerdictVariant(vs: VariantResult[], rep: VariantResult): VariantResult {
  const stocked = vs.filter(inStock);
  const pool = stocked.length > 0 ? stocked : vs;
  const top = Math.max(...pool.map((v) => RANK[v.verdict.label]));
  let worst = pool.filter((v) => RANK[v.verdict.label] === top);
  if (worst[0].verdict.label === 'avoid') {
    return worst.reduce((best, v) => (riseOf(v) > riseOf(best) ? v : best));
  }
  // a none that was judged (marked or claiming a discount) is shown over one that was not, so the group
  // counts as judged for the shop rating whenever one of its sold variants is
  const judged = worst.filter((v) => v.verdict.facts.judged);
  if (judged.length > 0) worst = judged;
  return worst.includes(rep) ? rep : cheapest(worst);
}

/**
 * One site_products row. For every label the row shows the variant whose verdict it stores (its link, prices,
 * stock, codes and history), so the stored price is the one the reason talks about (Ruling R57). Title, brand
 * and category always come from the representative so they do not change with the label.
 */
function buildGroup(groupKey: string, vs: VariantResult[], shop: Shop, settings: SiteSettings): GroupRow {
  const rep = pickRepresentative(vs);
  const chosen = pickVerdictVariant(vs, rep);
  const p = rep.product;
  const s = chosen.product;
  const title = p.title ?? vs.find((v) => v.product.title)?.product.title ?? '';
  return {
    group_key: groupKey,
    title,
    brand: p.brand ?? vs.find((v) => v.product.brand)?.product.brand ?? null,
    url: s.url,
    // a variant without its own picture falls back to the representative's
    image_url: s.image_url ?? p.image_url,
    category: categorize({ categoryPath: p.category_path, tags: p.tags ?? [], title, shopCategory: shop.category }, settings.categoryOverrides),
    variant_count: vs.length,
    rep_product_id: s.id,
    gtin: s.gtin,
    mpn: s.mpn,
    price_cents: chosen.latest?.price ?? null,
    was_price_cents: chosen.latest?.was ?? null,
    in_stock: chosen.latest?.inStock ?? null,
    bf_status: vs.some((v) => v.product.bf_status === 'marked') ? 'marked' : s.bf_status,
    verdict: chosen.verdict.label,
    reason: chosen.verdict.reason,
    facts: chosen.verdict.facts,
  };
}

/**
 * verdicts.claimed_pct / real_pct are numeric(5,2): rounded to 2 decimals; a value that would round to
 * abs >= 1000 (price glitches) is stored as null instead of overflowing the insert.
 */
export function pctColumn(v: number | null): number | null {
  // Postgres rounds half away from zero, so 999.995 and above would become 1000.00 and overflow.
  if (v === null || !Number.isFinite(v) || Math.abs(v) >= 999.995) return null;
  const r = (Math.sign(v) * Math.round(Math.abs(v) * 100)) / 100;
  return r === 0 ? 0 : r;
}

/** In the site_products upsert: the shown variant's GTIN or MPN differs from the stored row's. */
const CODES_CHANGED = `(site_products.gtin is distinct from excluded.gtin or site_products.mpn is distinct from excluded.mpn)`;

/**
 * In the site_products upsert: the shop renamed a name-matched or judged listing. Its clean name or judgement was
 * made for the old title, so the match no longer holds (review minor, as CODES_CHANGED).
 */
const NAME_CHANGED = `(site_products.match_method in ('name', 'judged') and site_products.title is distinct from excluded.title)`;
const MATCH_GONE = `(${CODES_CHANGED} or ${NAME_CHANGED})`;

/** postgres.js types a JS boolean array as a single boolean, so booleans travel as text[] and are cast per row. */
const boolText = (b: boolean | null) => (b === null ? null : String(b));

async function writeGroups(sql: postgres.Sql, shopId: number, groups: GroupRow[], now: Date): Promise<void> {
  if (groups.length === 0) return;
  const col = <K extends keyof GroupRow>(k: K) => groups.map((g) => g[k]);
  await sql`
    insert into site_products (shop_id, group_key, title, brand, url, image_url, category, variant_count, rep_product_id,
      gtin, mpn, price_cents, was_price_cents, in_stock, bf_status, verdict, reason, facts, updated_at)
    select ${shopId}, t.group_key, t.title, t.brand, t.url, t.image_url, t.category, t.variant_count, t.rep_product_id,
      t.gtin, t.mpn, t.price_cents, t.was_price_cents, t.in_stock::boolean, t.bf_status, t.verdict, t.reason, t.facts::jsonb, ${now}
    from unnest(
      ${col('group_key')}::text[], ${col('title')}::text[], ${col('brand')}::text[], ${col('url')}::text[],
      ${col('image_url')}::text[], ${col('category')}::text[], ${col('variant_count')}::int[], ${col('rep_product_id')}::bigint[],
      ${col('gtin')}::text[], ${col('mpn')}::text[], ${col('price_cents')}::int[], ${col('was_price_cents')}::int[],
      ${col('in_stock').map(boolText)}::text[], ${col('bf_status')}::text[], ${col('verdict')}::text[], ${col('reason')}::text[],
      ${groups.map((g) => JSON.stringify(g.facts))}::text[]
    ) as t(group_key, title, brand, url, image_url, category, variant_count, rep_product_id, gtin, mpn, price_cents,
      was_price_cents, in_stock, bf_status, verdict, reason, facts)
    on conflict (shop_id, group_key) do update set
      title = excluded.title, brand = excluded.brand, url = excluded.url, image_url = excluded.image_url,
      category = excluded.category, variant_count = excluded.variant_count, rep_product_id = excluded.rep_product_id,
      gtin = excluded.gtin, mpn = excluded.mpn, price_cents = excluded.price_cents, was_price_cents = excluded.was_price_cents,
      in_stock = excluded.in_stock, bf_status = excluded.bf_status, verdict = excluded.verdict, reason = excluded.reason,
      facts = excluded.facts, updated_at = excluded.updated_at,
      -- new codes: the old match (and its confirmation) no longer describes this row; assignCanonicalIds decides
      -- again after every shop is built, and until then the row claims no match (a build may stop in between)
      canonical_id = case when ${sql.unsafe(MATCH_GONE)} then null else site_products.canonical_id end,
      match_method = case when ${sql.unsafe(MATCH_GONE)} then null else site_products.match_method end,
      match_confirmed = case when ${sql.unsafe(MATCH_GONE)} then false else site_products.match_confirmed end`;

  // History of judged groups only, to keep storage small: one row per good/avoid group per run, all from the
  // variant that produced the label (rep_product_id and prices are that variant's for good/avoid groups).
  const judged = groups.filter((g) => g.verdict === 'good' || g.verdict === 'avoid');
  if (judged.length === 0) return;
  await sql`
    insert into verdicts (product_id, computed_at, label, price_cents, was_price_cents, low_30d_cents, history_days, claimed_pct, real_pct)
    select t.product_id, ${now}, t.label, t.price_cents, t.was_price_cents, t.low_30d_cents, t.history_days, t.claimed_pct, t.real_pct
    from unnest(
      ${judged.map((g) => g.rep_product_id)}::bigint[], ${judged.map((g) => g.verdict)}::text[],
      ${judged.map((g) => g.price_cents)}::int[], ${judged.map((g) => g.was_price_cents)}::int[],
      ${judged.map((g) => g.facts.low30)}::int[], ${judged.map((g) => g.facts.historyDays)}::int[],
      ${judged.map((g) => pctColumn(g.facts.claimedPct))}::numeric[], ${judged.map((g) => pctColumn(g.facts.realPct))}::numeric[]
    ) as t(product_id, label, price_cents, was_price_cents, low_30d_cents, history_days, claimed_pct, real_pct)`;
}

/** Builds one shop's site_products rows (no matching; buildSiteProducts runs assignCanonicalIds after all shops). */
export async function buildShop(sql: postgres.Sql, shop: Shop, settings: SiteSettings, now: Date): Promise<{ products: number; judged: number }> {
  const t = settings.thresholds;
  const seenSince = new Date(now.getTime() - SEEN_DAYS * DAY_MS);
  const obsSince = new Date(now.getTime() - (t.baselineDays + t.raiseWindowDays + 2) * DAY_MS);

  const products = await sql<ProductRow[]>`
    select id, coalesce(parent_external_id, external_id) as group_key, url, gtin, mpn, brand, title, category_path, tags,
      image_url, bf_status
    from products
    where shop_id = ${shop.id} and last_seen > ${seenSince}
    order by group_key, id`;

  const groups = new Map<string, ProductRow[]>();
  for (const p of products) {
    const g = groups.get(p.group_key);
    if (g) g.push(p);
    else groups.set(p.group_key, [p]);
  }
  const keys = [...groups.keys()];

  let judged = 0;
  for (let i = 0; i < keys.length; i += GROUP_BATCH) {
    const batchKeys = keys.slice(i, i + GROUP_BATCH);
    const ids = batchKeys.flatMap((k) => groups.get(k)!.map((p) => p.id));
    const obsRows = await sql<ObsRow[]>`
      select product_id, observed_at, price_cents, was_price_cents, in_stock, bf_marked
      from price_observations
      where product_id = any(${ids}::bigint[]) and observed_at > ${obsSince} and observed_at <= ${now}
        -- readings the scraper flagged as a 70% jump are unchecked glitches: never a verdict input (Ruling R55)
        and (review_flag is null or review_flag <> 'jump_70pct')`;
    const obsByProduct = new Map<string, ObsRow[]>();
    for (const o of obsRows) {
      const list = obsByProduct.get(o.product_id);
      if (list) list.push(o);
      else obsByProduct.set(o.product_id, [o]);
    }

    const rows = batchKeys.map((key) => {
      const variants = groups.get(key)!.map((p): VariantResult => {
        const obs = (obsByProduct.get(p.id) ?? []).map((o) => toObs(o, p.bf_status));
        let latest: Obs | null = null;
        for (const o of obs) if (latest === null || o.at > latest.at) latest = o;
        return { product: p, latest, verdict: computeVerdict(obs, t, now) };
      });
      return buildGroup(key, variants, shop, settings);
    });
    await writeGroups(sql, shop.id, rows, now);
    judged += rows.filter((r) => r.verdict === 'good' || r.verdict === 'avoid').length;
  }

  const keepSince = new Date(now.getTime() - KEEP_DAYS * DAY_MS);
  await sql`
    delete from site_products sp
    where sp.shop_id = ${shop.id}
      and not exists (
        select 1 from products p
        where p.shop_id = sp.shop_id and coalesce(p.parent_external_id, p.external_id) = sp.group_key and p.last_seen > ${keepSince})`;

  return { products: keys.length, judged };
}

type CanonRow = MatchInput & { brand: string | null; canonicalId: string | null; matchMethod: string | null };

/**
 * Canonical ids across shops: assignMatches over every site_products row, one canonical_products row per match
 * key (upserted by match_key). Rows no longer matched lose canonical_id and match_method. A confirmation
 * belongs to a (row, canonical group) pair (Ruling R50): a row whose canonical_id or match_method changes
 * (also to or from null) loses match_confirmed in the same statement; rows that keep both keep it.
 * With name matching on, rows whose checked canonical names (product_names.canonical_name) are exactly equal within
 * one category are also matched (matching.ts matchByName; method 'name', trusted like gtin and mpn on the site).
 * Returns the number of matched rows per method.
 * prior: each row's canonical id before this build's shops were built (they may clear it, as for new codes), so a
 * re-formed product keeps its id and a removed one records where its listings went (review I4).
 * opts.nameMatching: match by canonical name at all (owner decision 23 Oct: off until canonical names exist); while off,
 * no row is grouped by name, and rows grouped by name before lose that grouping.
 * opts.judgedMatching: group the listings Claude judged the same product (match_judgements, design "Update 23 Oct,
 * afternoon"; method 'judged', trusted like gtin and mpn on the site) while each judgement's fingerprint is current
 * and the veto in code does not overrule it (src/match/apply.ts). Off by default; while off, rows judged before lose
 * that grouping. opts.onJudged receives what the judgements gave.
 */
export async function assignCanonicalIds(
  sql: postgres.Sql,
  prior: Map<number, string> = new Map(),
  opts: { nameMatching?: boolean; judgedMatching?: boolean; onJudged?: (r: Resolved) => void } = {},
): Promise<Record<string, number>> {
  const byName = opts.nameMatching === true;
  // the checked canonical name of each row (name matching): only one stored for the row's current shop title, so a
  // renamed listing waits for the normaliser instead of matching under its old name; read through to_jsonb so the
  // build runs before migration 012 adds the column (no canonical names, no name matches)
  const raw = await sql<
    {
      id: string;
      shop_id: number;
      group_key: string;
      price_cents: number | null;
      gtin: string | null;
      mpn: string | null;
      title: string;
      brand: string | null;
      category: string | null;
      canonical_id: string | null;
      match_method: string | null;
      canonical_name: string | null;
      display_name: string | null;
      variant_label: string | null;
      name_category: string | null;
    }[]
  >`
    select sp.id, sp.shop_id, sp.group_key, sp.price_cents, sp.gtin, sp.mpn, sp.title, sp.brand, sp.category, sp.canonical_id, sp.match_method,
      to_jsonb(pn) ->> 'canonical_name' as canonical_name, pn.display_name, pn.variant_label, pn.category as name_category
    from site_products sp
    left join product_names pn on pn.shop_id = sp.shop_id and pn.group_key = sp.group_key
      and pn.status = 'ok' and pn.display_name is not null and pn.source_title = sp.title
    order by sp.id`;
  const rows = raw.map(
    (r): CanonRow => ({
      id: Number(r.id),
      shopId: r.shop_id,
      gtin: r.gtin,
      mpn: r.mpn,
      title: r.title,
      brand: r.brand,
      canonicalId: r.canonical_id,
      matchMethod: r.match_method,
      name: byName ? nameMatch(r.canonical_name, r.name_category ?? r.category, { title: r.title, displayName: r.display_name, variantLabel: r.variant_label }) : null,
    }),
  );
  const priorOf = (r: CanonRow) => prior.get(r.id) ?? r.canonicalId;
  let judged: number[][] = [];
  if (opts.judgedMatching === true) {
    const resolved = await judgedClusters(
      sql,
      raw.map((r) => ({ id: Number(r.id), shopId: r.shop_id, groupKey: r.group_key, title: r.title, brand: r.brand, category: r.category, gtin: r.gtin, mpn: r.mpn, priceCents: r.price_cents })),
    );
    judged = resolved.clusters;
    opts.onJudged?.(resolved);
  }
  const matches = await stableKeys(sql, rows, assignMatches(rows, { judged }), priorOf);

  // first member (lowest id) of each key describes the canonical product
  const firstOfKey = new Map<string, CanonRow>();
  for (const r of rows) {
    const m = matches.get(r.id);
    if (m && !firstOfKey.has(m.key)) firstOfKey.set(m.key, r);
  }
  const canonicalOfKey = new Map<string, string>();
  const entries = [...firstOfKey.entries()];
  for (let i = 0; i < entries.length; i += WRITE_BATCH) {
    const part = entries.slice(i, i + WRITE_BATCH);
    const got = await sql<{ id: string; match_key: string }[]>`
      insert into canonical_products (match_key, title, brand, gtin, mpn)
      select * from unnest(
        ${part.map(([k]) => k)}::text[], ${part.map(([, r]) => r.title)}::text[], ${part.map(([, r]) => r.brand)}::text[],
        ${part.map(([, r]) => r.gtin)}::text[], ${part.map(([, r]) => r.mpn)}::text[])
      on conflict (match_key) do update set title = excluded.title, brand = excluded.brand, gtin = excluded.gtin, mpn = excluded.mpn
      returning id, match_key`;
    for (const g of got) canonicalOfKey.set(g.match_key, g.id);
  }

  const counts: Record<string, number> = {};
  const changed: { id: number; cid: string | null; method: string | null }[] = [];
  for (const r of rows) {
    const m = matches.get(r.id);
    const cid = m ? canonicalOfKey.get(m.key)! : null;
    const method = m ? m.method : null;
    if (m) counts[m.method] = (counts[m.method] ?? 0) + 1;
    if (cid !== r.canonicalId || method !== r.matchMethod) changed.push({ id: r.id, cid, method });
  }
  for (let i = 0; i < changed.length; i += WRITE_BATCH) {
    const part = changed.slice(i, i + WRITE_BATCH);
    await sql`
      update site_products sp set canonical_id = t.cid, match_method = t.method, match_confirmed = false
      from unnest(${part.map((c) => c.id)}::bigint[], ${part.map((c) => c.cid)}::bigint[], ${part.map((c) => c.method)}::text[])
        as t(id, cid, method)
      where sp.id = t.id`;
  }

  // canonical rows made by site-build that nothing points at any more (e.g. a title group whose first item left)
  const removed = await sql<{ id: string }[]>`
    delete from canonical_products c
    where c.match_key is not null
      and not exists (select 1 from site_products sp where sp.canonical_id = c.id)
      and not exists (select 1 from products p where p.canonical_id = c.id)
      and not exists (select 1 from product_matches pm where pm.canonical_id = c.id)
    returning id`;
  await recordRedirects(sql, rows, changed, removed.map((r) => r.id), priorOf);

  return counts;
}

/** Stable product links for name groups and judged groups (see stableMethodKeys). */
async function stableKeys(sql: postgres.Sql, rows: CanonRow[], matches: Map<number, Match>, priorOf: (r: CanonRow) => string | null): Promise<Map<number, Match>> {
  const named = await stableMethodKeys(sql, rows, matches, priorOf, 'name');
  return stableMethodKeys(sql, rows, named, priorOf, 'judged');
}

/**
 * Stable product links (review I4): a name or judged group that forms again keeps the canonical product most of its
 * members already have (the most common one, then the oldest), so /product/c<id> keeps working while its first
 * member changes. Only a group's own canonical of the same method (match key name:... or judged:...) is reused, each
 * by one group; a group that gets a new key never takes over the key of an existing canonical product.
 */
async function stableMethodKeys(
  sql: postgres.Sql,
  rows: CanonRow[],
  matches: Map<number, Match>,
  priorOf: (r: CanonRow) => string | null,
  method: 'name' | 'judged',
): Promise<Map<number, Match>> {
  const prefix = `${method}:`;
  const groups = new Map<string, CanonRow[]>();
  for (const r of rows) {
    const m = matches.get(r.id);
    if (!m || m.method !== method || !m.key.startsWith(prefix)) continue;
    const g = groups.get(m.key);
    if (g) g.push(r);
    else groups.set(m.key, [r]);
  }
  if (groups.size === 0) return matches;
  const existing = await sql<{ id: string; match_key: string }[]>`select id, match_key from canonical_products where match_key like ${`${prefix}%`}`;
  const keyOfId = new Map(existing.map((e) => [e.id, e.match_key]));
  const taken = new Set(existing.map((e) => e.match_key));
  const used = new Set<string>();
  const rename = new Map<string, string>();
  const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  for (const [key, members] of order) {
    const votes = new Map<string, number>();
    for (const m of members) {
      const was = priorOf(m);
      if (was !== null && keyOfId.has(was)) votes.set(was, (votes.get(was) ?? 0) + 1);
    }
    const best = [...votes.entries()]
      .filter(([id]) => !used.has(keyOfId.get(id)!))
      .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0];
    let next = best ? keyOfId.get(best[0])! : key;
    if (!best) for (let n = 1; used.has(next) || taken.has(next); n++) next = `${key}.${n}`;
    used.add(next);
    if (next !== key) rename.set(key, next);
  }
  if (rename.size === 0) return matches;
  const out = new Map<number, Match>();
  for (const [id, m] of matches) out.set(id, rename.has(m.key) ? { ...m, key: rename.get(m.key)! } : m);
  return out;
}

/**
 * Where removed canonical products went (review I4): the canonical most of a removed product's former members now
 * belong to (then the oldest), so its old link can follow them. Earlier redirects to a removed product follow it
 * too. Skipped until migration 011 has run.
 */
async function recordRedirects(
  sql: postgres.Sql,
  rows: CanonRow[],
  changed: { id: number; cid: string | null }[],
  removed: string[],
  priorOf: (r: CanonRow) => string | null,
): Promise<void> {
  if (removed.length === 0) return;
  const [{ t }] = await sql<{ t: string | null }[]>`select to_regclass('canonical_redirects')::text as t`;
  if (t === null) return;
  const gone = new Set(removed);
  const before = new Map(rows.map((r) => [r.id, priorOf(r)]));
  const votes = new Map<string, Map<string, number>>();
  for (const c of changed) {
    const old = before.get(c.id);
    if (!old || !gone.has(old) || c.cid === null) continue;
    const v = votes.get(old) ?? new Map<string, number>();
    v.set(c.cid, (v.get(c.cid) ?? 0) + 1);
    votes.set(old, v);
  }
  const pairs = [...votes.entries()].map(([old, v]) => [old, [...v.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0][0]] as const);
  if (pairs.length === 0) return;
  await sql`
    update canonical_redirects r set new_id = t.new_id
    from unnest(${pairs.map(([o]) => o)}::bigint[], ${pairs.map(([, n]) => n)}::bigint[]) as t(old_id, new_id)
    where r.new_id = t.old_id`;
  await sql`
    insert into canonical_redirects (old_id, new_id)
    select * from unnest(${pairs.map(([o]) => o)}::bigint[], ${pairs.map(([, n]) => n)}::bigint[])
    on conflict (old_id) do update set new_id = excluded.new_id, created_at = now()`;
}

/** nameMatching, judgedMatching: group listings by clean name, by Claude's judgements (both off by default; see assignCanonicalIds) */
export type BuildOptions = { shop?: string; log?: (line: string) => void; nameMatching?: boolean; judgedMatching?: boolean };

/**
 * Builds site_products for every active, visible shop (or one shop with { shop }), then canonical ids.
 * Hidden or inactive shops lose their site_products rows.
 */
export async function buildSiteProducts(
  sql: postgres.Sql,
  settings: SiteSettings,
  now: Date,
  opts: BuildOptions = {},
): Promise<{ products: number; judged: number }> {
  const log = opts.log ?? (() => {});
  await sql`delete from site_products where shop_id in (select id from shops where site_hidden or not active)`;

  const shops = await sql<Shop[]>`
    select id, slug, category from shops
    where active and not site_hidden ${opts.shop === undefined ? sql`` : sql`and slug = ${opts.shop}`}
    order by slug`;
  if (opts.shop !== undefined && shops.length === 0) throw new Error(`No active, visible shop with slug ${opts.shop}`);

  // each row's canonical id before the shops are built: a shop build clears it for new codes (CODES_CHANGED)
  const prior = new Map(
    (await sql<{ id: string; canonical_id: string }[]>`select id, canonical_id from site_products where canonical_id is not null`).map((r) => [Number(r.id), r.canonical_id]),
  );
  let products = 0;
  let judged = 0;
  for (const shop of shops) {
    const started = Date.now();
    const r = await buildShop(sql, shop, settings, now);
    products += r.products;
    judged += r.judged;
    log(`[${shop.slug}] ${r.products} groups, ${r.judged} judged, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  const started = Date.now();
  const matched = await assignCanonicalIds(sql, prior, {
    nameMatching: opts.nameMatching === true,
    judgedMatching: opts.judgedMatching === true,
    onJudged: (r) => log(`judged matching: ${r.read} judgements, ${r.used} current, ${r.stale} stale, ${r.vetoed} pairs vetoed today, ${r.clusters.length} clusters`),
  });
  log(`matching: ${JSON.stringify(matched)}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { products, judged };
}

/** Days a site_products row stays on the public site after its last build (Ruling R21); ratings count the same rows. */
export const FRESH_DAYS = 2;

/** One shop_ratings row per active, visible shop from its fresh site_products; hidden or inactive shops lose theirs. */
export async function buildShopRatings(sql: postgres.Sql, settings: SiteSettings, now: Date): Promise<number> {
  const freshSince = new Date(now.getTime() - FRESH_DAYS * DAY_MS);
  const counts = await sql<{ shop_id: number; judged: number; good: number; avoid: number; was_raised: number }[]>`
    select s.id as shop_id,
      count(sp.id) filter (where ${sql.unsafe(JUDGED_SQL)})::int as judged,
      count(sp.id) filter (where sp.verdict = 'good')::int as good,
      count(sp.id) filter (where sp.verdict = 'avoid')::int as avoid,
      count(sp.id) filter (where sp.verdict in ('good', 'avoid') and sp.facts -> 'wasRaisedFrom' is not null)::int as was_raised
    from shops s
    left join site_products sp on sp.shop_id = s.id and sp.updated_at > ${freshSince}
    where s.active and not s.site_hidden
    group by s.id
    order by s.id`;

  await sql`delete from shop_ratings where shop_id in (select id from shops where site_hidden or not active)`;
  if (counts.length === 0) return 0;

  const rated = counts.map((c) => ({ ...c, ...computeRating({ judged: c.judged, good: c.good, avoid: c.avoid, wasRaised: c.was_raised }, settings.thresholds) }));
  await sql`
    insert into shop_ratings (shop_id, grade, judged, good, avoid, was_raised, sentence, computed_at)
    select t.shop_id, t.grade, t.judged, t.good, t.avoid, t.was_raised, t.sentence, ${now}
    from unnest(
      ${rated.map((r) => r.shop_id)}::int[], ${rated.map((r) => r.grade)}::text[], ${rated.map((r) => r.judged)}::int[],
      ${rated.map((r) => r.good)}::int[], ${rated.map((r) => r.avoid)}::int[], ${rated.map((r) => r.was_raised)}::int[],
      ${rated.map((r) => r.sentence)}::text[]
    ) as t(shop_id, grade, judged, good, avoid, was_raised, sentence)
    on conflict (shop_id) do update set
      grade = excluded.grade, judged = excluded.judged, good = excluded.good, avoid = excluded.avoid,
      was_raised = excluded.was_raised, sentence = excluded.sentence, computed_at = excluded.computed_at`;
  return rated.length;
}

/** site_settings key holding { at: ISO time } of the last successful full build (internal; loadSettings ignores it). */
export const LAST_FULL_BUILD_KEY = 'lastFullBuild';

/** Records a successful full build (all shops, ratings included). Partial (--shop) or failed runs must not call this. */
export async function markFullBuild(sql: postgres.Sql, at: Date): Promise<void> {
  await sql`
    insert into site_settings (key, value, updated_at)
    values (${LAST_FULL_BUILD_KEY}, ${sql.json({ at: at.toISOString() })}, ${at})
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`;
}

/** Time of the last successful full build, or null when none is recorded. */
export async function lastFullBuild(sql: postgres.Sql): Promise<Date | null> {
  const rows = await sql<{ value: unknown }[]>`select value from site_settings where key = ${LAST_FULL_BUILD_KEY}`;
  const at = (rows[0]?.value as { at?: unknown } | undefined)?.at;
  if (typeof at !== 'string') return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Time of the newest scrape activity: the latest finished_at, or the started_at of a run still going (a run in
 * progress counts from its start). Null when no scrape ever ran.
 */
export async function lastScrapeActivity(sql: postgres.Sql): Promise<Date | null> {
  const [{ at }] = await sql<{ at: Date | null }[]>`select max(coalesce(finished_at, started_at)) as at from scrape_runs`;
  return at ? new Date(at) : null;
}

/**
 * --skip-if-built-hours (the backup cron): skip only when a full build ran within `hours` and no scrape finished
 * (or started) after that build began, so a build that ran while cloud scrapes were still going is redone once
 * they finish. lastBuild is the build's start time (markFullBuild), the time its data was read up to.
 */
export function shouldSkipBuild(o: { lastBuild: Date | null; lastScrape: Date | null; now: Date; hours: number }): boolean {
  if (o.lastBuild === null) return false;
  if (o.now.getTime() - o.lastBuild.getTime() >= o.hours * 3_600_000) return false;
  return o.lastScrape === null || o.lastScrape.getTime() <= o.lastBuild.getTime();
}

/** Fixed advisory lock id for site-build ("SBLD"). */
export const SITE_BUILD_LOCK = 0x53424c44;

/**
 * Runs fn while holding the site-build advisory lock; returns false without running it when another build holds it.
 * The lock is transaction scoped and held by an open transaction on one pooled connection, because DATABASE_URL
 * may go through Neon's transaction-mode pooler, where a session lock would stay on a server connection the
 * client no longer owns. The transaction does no writes; it ends (and frees the lock) when fn settles or the
 * process dies. The idle-in-transaction timeout is lifted for it, since a build can take longer than Neon's 5 min.
 */
export async function withBuildLock(sql: postgres.Sql, fn: () => Promise<void>): Promise<boolean> {
  let ran = false;
  await sql.begin(async (tx) => {
    await tx`set local idle_in_transaction_session_timeout = 0`;
    const [{ ok }] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(${SITE_BUILD_LOCK}::bigint) as ok`;
    if (!ok) return;
    ran = true;
    await fn();
  });
  return ran;
}
