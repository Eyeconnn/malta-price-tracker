// All SQL of the public read API. Reads use the read-only role (Env.DATABASE_URL = dashboard_ro).
// Every query shows only visible shops (active, not site_hidden) and site_products rows refreshed in the last
// 2 days (Rulings R21, R28). The SQL runs through a small runner so tests can use PGlite instead of Neon.
import { neon } from '@neondatabase/serverless';
import { type Grade, JUDGED_SQL } from '../../src/site/rating.js';
import { type SiteSettings, settingsFromRows } from '../../src/site/settings.js';
import type { Obs, VerdictFacts } from '../../src/site/verdict.js';

export type Label = 'good' | 'avoid' | 'none' | 'insufficient';

/** A product group on a list. id = site_products.id; prices are cents, null when the shop shows none. */
export type Card = {
  id: number;
  title: string;
  shop: string;
  shopSlug: string;
  priceCents: number | null;
  wasCents: number | null;
  verdict: Label;
  reason: string | null;
  bf: boolean;
  category: string | null;
  /** avoid only: the price before a recent price rise and its Malta day (facts.raisedFrom), else null */
  raisedFrom: { priceCents: number; at: string } | null;
  /** avoid only: the was price before a recent was-price rise (facts.wasRaisedFrom), else null */
  wasRaisedFromCents: number | null;
};

/** Ruling R2: Obs with an ISO time, as JSON carries it. */
export type ApiObs = Omit<Obs, 'at'> & { at: string };
/** One history point of one variant (products.id). */
export type HistoryObs = ApiObs & { productId: number };

/** A search query: plain text for word_similarity, and the same text as an escaped ILIKE pattern. */
export type SearchPattern = { text: string; like: string };
/**
 * A search hit or a member of a hit's trusted group. groupKey is 'c<canonical_id>' for a row matched by GTIN/MPN
 * or confirmed by the admin, else 's<site_products id>' (the row alone). groupTitle: the title of the group's
 * best hit, the row that matched the search best.
 */
export type SearchHit = Card & {
  groupKey: string;
  groupTitle: string;
  canonicalId: number | null;
  possible: boolean;
  inStock: boolean | null;
  /** the row's accepted clean name (product_names, stored for its current shop title), null without one */
  displayName: string | null;
  /** the clean variant label ("512GB, 12GB, Grey"), null without one */
  variantLabel: string | null;
  /** the category the clean name and attributes were made for */
  nameCategory: string | null;
  attrs: Record<string, unknown> | null;
  imageUrl: string | null;
  /**
   * The whole product in the search (every visible member, also past the rows listed): how many shops sell it,
   * whether one marks it Black Friday, how many sellers have each verdict, its lowest price not known out of stock
   * and its lowest price (cents, null when none).
   */
  groupShops: number;
  groupBf: boolean;
  groupGood: number;
  groupAvoid: number;
  groupLowInStock: number | null;
  groupLow: number | null;
};

export type ShopSummary = { slug: string; name: string; grade: Grade | null; products: number };
export type ShopInfo = { id: number; slug: string; name: string; url: string; category: string | null };
export type ShopRating = { grade: Grade | null; sentence: string; judged: number };
export type ShopStats = {
  products: number;
  judged: number;
  good: number;
  avoid: number;
  wasRaised: number;
  bfMarked: number;
  /** good / judged in %, null when nothing was judged */
  realDealPct: number | null;
};
/** Latest price against the last different price in the last `days` days (raiseWindowDays), of a group's shown variant. */
export type Change = { id: number; title: string; fromCents: number; toCents: number; pct: number; fromAt: string; at: string };

export type ProductInfo = {
  id: number;
  /** the product page this listing belongs to (/product/<key>): 'c<canonical id>' when trusted, else 's<id>' */
  key: string;
  /** products.id of the shown variant: the target of product reports (Ruling R20) */
  productId: number | null;
  title: string;
  brand: string | null;
  url: string | null;
  imageUrl: string | null;
  category: string | null;
  shopId: number;
  shop: string;
  shopSlug: string;
  priceCents: number | null;
  wasCents: number | null;
  inStock: boolean | null;
  bf: boolean;
  variantCount: number;
  canonicalId: number | null;
  matchMethod: string | null;
  matchConfirmed: boolean;
  verdict: Label;
  reason: string | null;
  facts: VerdictFacts | null;
};
export type Variant = { id: number; title: string | null; variantTitle: string | null; priceCents: number | null; inStock: boolean | null };
/** The same product at another shop. possible: linked by title only, without admin confirmation of both rows. */
export type OtherShop = {
  id: number;
  title: string;
  shop: string;
  shopSlug: string;
  priceCents: number | null;
  inStock: boolean | null;
  verdict: Label;
  matchMethod: string | null;
  possible: boolean;
};
export type ProductDetail = { product: ProductInfo; variants: Variant[]; history: HistoryObs[]; others: OtherShop[] };

/**
 * One shop selling a product (a site_products row of the product's group, with its clean name). Prices and
 * stock are the row's shown variant's (R19, R57); productId is that variant, the target of product reports (R20).
 */
export type Seller = {
  id: number;
  productId: number | null;
  groupKey: string;
  shopId: number;
  shop: string;
  shopSlug: string;
  /** the shop's own title */
  title: string;
  brand: string | null;
  url: string | null;
  imageUrl: string | null;
  category: string | null;
  priceCents: number | null;
  wasCents: number | null;
  inStock: boolean | null;
  bf: boolean;
  matchMethod: string | null;
  verdict: Label;
  reason: string | null;
  facts: VerdictFacts | null;
  displayName: string | null;
  variantLabel: string | null;
  nameCategory: string | null;
  attrs: Record<string, unknown> | null;
};
/** One variant (products row) of a seller's group, with its latest unflagged reading. */
/** seenAt: the time of its newest unflagged reading (ISO), null when it has none (review I3) */
export type SellerVariant = {
  id: number;
  sellerId: number;
  title: string | null;
  variantTitle: string | null;
  priceCents: number | null;
  inStock: boolean | null;
  seenAt: string | null;
};
export type SellerHistoryObs = HistoryObs & { sellerId: number };
/**
 * A product page: key 'c<canonical id>' (trusted members: GTIN, MPN, name, or confirmed) or 's<site_products id>'
 * (a listing alone). Sellers cheapest first; history per seller (60 days, flagged jumps left out, newest kept).
 */
export type ProductGroup = { key: string; canonicalId: number | null; sellers: Seller[]; variants: SellerVariant[]; history: SellerHistoryObs[] };

/** minCents/maxCents: inclusive price range in cents; when either is set, rows without a price are left out */
export type DealsQuery = {
  verdict: 'good' | 'avoid';
  category: string | null;
  shop: string | null;
  minCents: number | null;
  maxCents: number | null;
  limit: number;
  offset: number;
};
/** slug '' counts the rows without a category */
export type CategoryCount = { slug: string; count: number; good: number; avoid: number };

export interface Data {
  settings(): Promise<SiteSettings>;
  /** good lists never include rows without a positive price */
  deals(q: DealsQuery): Promise<{ items: Card[]; total: number }>;
  /** hits ordered by their group's best hit (max 40 groups), plus the visible trusted members of each trusted hit's group */
  search(p: SearchPattern, shop: string | null): Promise<SearchHit[]>;
  shops(): Promise<ShopSummary[]>;
  shop(slug: string): Promise<{ shop: ShopInfo; rating: ShopRating | null; stats: ShopStats } | null>;
  /** days: how far back to look, the stored raiseWindowDays */
  shopChanges(shopId: number, days: number): Promise<{ rises: Change[]; drops: Change[] }>;
  product(id: number): Promise<ProductDetail | null>;
  /** the product page by key ('c<canonical id>' or 's<site_products id>'); a trusted row's 's' key gives its canonical product */
  productGroup(key: string): Promise<ProductGroup | null>;
  categories(): Promise<CategoryCount[]>;
}

type Row = Record<string, unknown>;
export type Statement = { text: string; params: unknown[] };

/** Runs SQL with $n parameters; transaction runs the statements in one read-only transaction. */
export interface SqlRunner {
  query(text: string, params: unknown[]): Promise<Row[]>;
  transaction(statements: Statement[]): Promise<Row[][]>;
}

export function neonRunner(databaseUrl: string): SqlRunner {
  const sql = neon(databaseUrl);
  return {
    query: (text, params) => sql.query(text, params) as Promise<Row[]>,
    transaction: (statements) =>
      sql.transaction(
        statements.map((s) => sql.query(s.text, s.params)),
        { readOnly: true },
      ) as Promise<Row[][]>,
  };
}

/** Visible shop and fresh site_products row (R21, R28); needs aliases sp and s. */
const VISIBLE = `s.active and not s.site_hidden and sp.updated_at > now() - interval '2 days'`;

/**
 * SQL: the row's match is exact (GTIN/MPN, checked canonical name, judged by Claude and not vetoed, or confirmed by
 * the admin) and so may group publicly (R30); needs alias sp.
 */
const TRUSTED = `(sp.canonical_id is not null and (sp.match_method in ('gtin', 'mpn', 'name', 'judged') or sp.match_confirmed))`;

/**
 * The row's accepted clean name (design Part 2): only one stored for its current shop title, as the site build
 * matches on it; needs alias sp, gives alias pn.
 */
const NAME_JOIN = `left join product_names pn on pn.shop_id = sp.shop_id and pn.group_key = sp.group_key
  and pn.status = 'ok' and pn.display_name is not null and pn.source_title = sp.title`;

const CARD_COLUMNS = `sp.id, sp.title, s.name as shop, s.slug as shop_slug, sp.price_cents, sp.was_price_cents, sp.verdict,
  sp.reason, sp.bf_status, sp.category, sp.facts -> 'raisedFrom' as raised_from, sp.facts ->> 'wasRaisedFrom' as was_raised_from`;

/** word_similarity threshold for `<%`, as in the dashboard search. */
const WORD_SIMILARITY = '0.5';
const HISTORY_DAYS = 60;
const CHANGES_EACH = 10;
const OTHERS_MAX = 30;
/** Sellers on one product page. */
const SELLERS_MAX = 30;
const VARIANTS_MAX = 200;
/**
 * A product page keeps every reading of each seller's verdict variant within this many days: the whole history
 * window, so no cap ever cuts the stored raise window (at most 60 days) or the lowest 30 days.
 */
const KEEP_DAYS = HISTORY_DAYS;
const HISTORY_MAX = 5000;
const SEARCH_HITS = 200;
const SEARCH_GROUPS = 40;
const GROUP_MEMBERS = 20;

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
/** A price in cents: 0 or less (or missing) means the shop shows no price, so null, never 0. */
const priceOrNull = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n !== null && n > 0 ? n : null;
};
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const boolOrNull = (v: unknown): boolean | null => (v === null || v === undefined ? null : Boolean(v));
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();

/**
 * A row of a site_products group counts as exactly matched when matched by GTIN/MPN, by clean name and key specs
 * (design Part 3: the name passed the safety check and the specs agree), judged the same product by Claude and not
 * vetoed (design "Update 23 Oct, afternoon"), or confirmed by the admin.
 */
export function trustedMatch(method: string | null, confirmed: boolean): boolean {
  return method === 'gtin' || method === 'mpn' || method === 'name' || method === 'judged' || confirmed;
}

/** The product page key of a row: its canonical product when trusted, else the row alone. */
export function productKey(id: number, canonicalId: number | null, method: string | null, confirmed: boolean): string {
  return canonicalId !== null && trustedMatch(method, confirmed) ? `c${canonicalId}` : `s${id}`;
}

const objOrNull = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** facts.raisedFrom ({ price, at: 'YYYY-MM-DD' }) as card data; null unless both parts are valid. */
function raisedFromOrNull(v: unknown): Card['raisedFrom'] {
  if (typeof v !== 'object' || v === null) return null;
  const { price, at } = v as { price?: unknown; at?: unknown };
  const priceCents = priceOrNull(price);
  return priceCents !== null && typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at) ? { priceCents, at } : null;
}

function toCard(r: Row): Card {
  const avoid = r.verdict === 'avoid';
  return {
    id: num(r.id),
    title: String(r.title),
    shop: String(r.shop),
    shopSlug: String(r.shop_slug),
    priceCents: priceOrNull(r.price_cents),
    wasCents: priceOrNull(r.was_price_cents),
    verdict: r.verdict as Label,
    reason: strOrNull(r.reason),
    bf: r.bf_status === 'marked',
    category: strOrNull(r.category),
    raisedFrom: avoid ? raisedFromOrNull(r.raised_from) : null,
    wasRaisedFromCents: avoid ? priceOrNull(r.was_raised_from) : null,
  };
}

function toChange(r: Row): Change {
  return {
    id: num(r.id),
    title: String(r.title),
    fromCents: num(r.from_cents),
    toCents: num(r.to_cents),
    pct: num(r.pct),
    fromAt: iso(r.from_at),
    at: iso(r.at),
  };
}

// good: largest real drop below the 30-day low first (realPct is negative for a drop);
// avoid: largest rise first (price rise, else was-price rise), as the site-build ranks avoids.
const DEAL_RANK = `case when sp.verdict = 'good' then -(sp.facts ->> 'realPct')::float8
  else coalesce(
    ((sp.facts -> 'raisedTo' ->> 'price')::float8 - (sp.facts -> 'raisedFrom' ->> 'price')::float8)
      / nullif((sp.facts -> 'raisedFrom' ->> 'price')::float8, 0),
    (sp.was_price_cents - (sp.facts ->> 'wasRaisedFrom')::float8) / nullif((sp.facts ->> 'wasRaisedFrom')::float8, 0))
  end`;

export type DataOptions = {
  /** most history points per product page (default 5000); the newest are kept */
  historyMax?: number;
  /** most variants per product page (default 200), shared out per seller; each seller keeps its verdict variant */
  variantsMax?: number;
  /** most rows listed per search group (default 20); the group's counts cover every member */
  searchMembers?: number;
};

export function createData(db: SqlRunner, opts: DataOptions = {}): Data {
  const historyMax = opts.historyMax ?? HISTORY_MAX;
  const variantsMax = opts.variantsMax ?? VARIANTS_MAX;
  const searchMembers = opts.searchMembers ?? GROUP_MEMBERS;
  async function loadGroup(key: string, follow: boolean): Promise<ProductGroup | null> {
      const m = /^([cs])(\d{1,15})$/.exec(key);
      if (!m) return null;
      let canonicalId: number | null = m[1] === 'c' ? Number(m[2]) : null;
      let rowId: number | null = m[1] === 's' ? Number(m[2]) : null;
      if (rowId !== null) {
        // a listing that belongs to a product (trusted match) shows that product
        const [row] = await db.query(
          `select sp.canonical_id, ${TRUSTED} as trusted from site_products sp join shops s on s.id = sp.shop_id where sp.id = $1 and ${VISIBLE}`,
          [rowId],
        );
        if (!row) return null;
        if (row.trusted === true) {
          canonicalId = num(row.canonical_id);
          rowId = null;
        }
      }
      // Only trusted members are sellers of one product (R30): a title-only match never joins.
      const sellerRows = await db.query(
        `select sp.id, sp.rep_product_id, sp.group_key, sp.shop_id, s.name as shop, s.slug as shop_slug, sp.title, sp.brand, sp.url,
          sp.image_url, sp.category, sp.price_cents, sp.was_price_cents, sp.in_stock, sp.bf_status, sp.match_method, sp.verdict,
          sp.reason, sp.facts, pn.display_name, pn.variant_label, pn.category as name_category, pn.attrs
        from site_products sp join shops s on s.id = sp.shop_id
        ${NAME_JOIN}
        where ${VISIBLE}
          and (($1::bigint is not null and sp.canonical_id = $1 and ${TRUSTED}) or ($1::bigint is null and sp.id = $2::bigint))
        order by nullif(sp.price_cents, 0) asc nulls last, sp.id
        limit ${SELLERS_MAX}`,
        [canonicalId, rowId],
      );
      if (sellerRows.length === 0) {
        // a removed product: follow where its listings went (review I4, migration 011), once
        if (!follow || canonicalId === null) return null;
        let to: number | null = null;
        try {
          const [r] = await db.query('select new_id from canonical_redirects where old_id = $1', [canonicalId]);
          to = r ? num(r.new_id) : null;
        } catch {
          // no redirects table yet: no redirects
        }
        return to !== null && to !== canonicalId ? loadGroup(`c${to}`, false) : null;
      }
      const sellers: Seller[] = sellerRows.map((r) => ({
        id: num(r.id),
        productId: numOrNull(r.rep_product_id),
        groupKey: String(r.group_key),
        shopId: num(r.shop_id),
        shop: String(r.shop),
        shopSlug: String(r.shop_slug),
        title: String(r.title),
        brand: strOrNull(r.brand),
        url: strOrNull(r.url),
        imageUrl: strOrNull(r.image_url),
        category: strOrNull(r.category),
        priceCents: priceOrNull(r.price_cents),
        wasCents: priceOrNull(r.was_price_cents),
        inStock: boolOrNull(r.in_stock),
        bf: r.bf_status === 'marked',
        matchMethod: strOrNull(r.match_method),
        verdict: r.verdict as Label,
        reason: strOrNull(r.reason),
        facts: (r.facts ?? null) as VerdictFacts | null,
        displayName: strOrNull(r.display_name),
        variantLabel: strOrNull(r.variant_label),
        nameCategory: strOrNull(r.name_category),
        attrs: objOrNull(r.attrs),
      }));

      // per seller the same index range scans as the single-shop product page (shop_id, group key)
      const groups = [sellers.map((s) => s.id), sellers.map((s) => s.shopId), sellers.map((s) => s.groupKey), sellers.map((s) => s.productId)];
      const perSeller = Math.max(1, Math.ceil(historyMax / sellers.length));
      // every seller gets its share of the variants, its verdict variant first
      const variantsPer = Math.max(1, Math.floor(variantsMax / sellers.length));
      const [variantRows, historyRows] = await Promise.all([
        db.query(
          `select g.seller_id, p.id, p.title, p.variant_title, lo.price_cents, lo.in_stock, lo.observed_at
          from unnest($1::bigint[], $2::int[], $3::text[], $4::bigint[]) as g(seller_id, shop_id, group_key, rep_id)
          cross join lateral (
            select p.id, p.title, p.variant_title from products p
            where p.shop_id = g.shop_id and coalesce(p.parent_external_id, p.external_id) = g.group_key
            order by (p.id = g.rep_id) desc nulls last, p.id limit $5
          ) p
          left join lateral (
            select po.price_cents, po.in_stock, po.observed_at from price_observations po
            where po.product_id = p.id and (po.review_flag is null or po.review_flag <> 'jump_70pct')
            order by po.observed_at desc limit 1
          ) lo on true
          order by g.seller_id, p.id`,
          [...groups, variantsPer],
        ),
        // each seller keeps its newest points within its share of the cap, and every reading of its verdict variant
        // in the history window (the raise window and the lowest 30 days are never cut), returned oldest first
        db.query(
          `select g.seller_id, h.* from unnest($1::bigint[], $2::int[], $3::text[], $4::bigint[]) as g(seller_id, shop_id, group_key, rep_id)
          cross join lateral (
            (select po.product_id, po.observed_at, po.price_cents, po.was_price_cents, po.in_stock,
              coalesce(po.bf_marked, coalesce(p.bf_status = 'marked', false)) as bf
            from products p join price_observations po on po.product_id = p.id
            where p.shop_id = g.shop_id and coalesce(p.parent_external_id, p.external_id) = g.group_key
              and po.observed_at > now() - interval '${HISTORY_DAYS} days'
              -- unchecked 70% jumps are left out, as the verdicts leave them out (Ruling R55)
              and (po.review_flag is null or po.review_flag <> 'jump_70pct')
            order by po.observed_at desc, po.product_id desc
            limit $5)
            union
            (select po.product_id, po.observed_at, po.price_cents, po.was_price_cents, po.in_stock,
              coalesce(po.bf_marked, coalesce(p.bf_status = 'marked', false)) as bf
            from products p join price_observations po on po.product_id = p.id
            where p.id = g.rep_id and p.shop_id = g.shop_id
              and po.observed_at > now() - interval '${KEEP_DAYS} days'
              and (po.review_flag is null or po.review_flag <> 'jump_70pct'))
          ) h
          order by h.observed_at, g.seller_id, h.product_id`,
          [...groups, perSeller],
        ),
      ]);

      return {
        key: canonicalId !== null ? `c${canonicalId}` : `s${rowId}`,
        canonicalId,
        sellers,
        variants: variantRows.map((v) => ({
          id: num(v.id),
          sellerId: num(v.seller_id),
          title: strOrNull(v.title),
          variantTitle: strOrNull(v.variant_title),
          priceCents: priceOrNull(v.price_cents),
          inStock: boolOrNull(v.in_stock),
          seenAt: v.observed_at === null || v.observed_at === undefined ? null : iso(v.observed_at),
        })),
        history: historyRows.map((h) => ({
          sellerId: num(h.seller_id),
          productId: num(h.product_id),
          at: iso(h.observed_at),
          price: priceOrNull(h.price_cents),
          was: priceOrNull(h.was_price_cents),
          inStock: boolOrNull(h.in_stock),
          bf: boolOrNull(h.bf),
        })),
      };
  }

  return {
    async settings() {
      const rows = await db.query('select key, value from site_settings', []);
      return settingsFromRows(rows.map((r) => ({ key: String(r.key), value: r.value })));
    },

    async deals(q) {
      const rows = await db.query(
        `with f as (
          select ${CARD_COLUMNS}, ${DEAL_RANK} as rank
          from site_products sp join shops s on s.id = sp.shop_id
          where sp.verdict = $1 and ${VISIBLE}
            and ($2::text is null or sp.category = $2)
            and ($3::text is null or s.slug = $3)
            and (sp.verdict <> 'good' or sp.price_cents > 0)
            and ($4::int is null or sp.price_cents >= $4)
            and ($5::int is null or sp.price_cents <= $5)
            and (($4::int is null and $5::int is null) or sp.price_cents > 0)
        )
        select t.total, x.*
        from (select count(*)::int as total from f) t
        left join lateral (select * from f order by rank desc nulls last, id limit $6 offset $7) x on true`,
        [q.verdict, q.category, q.shop, q.minCents, q.maxCents, q.limit, q.offset],
      );
      return { items: rows.filter((r) => r.id !== null && r.id !== undefined).map(toCard), total: num(rows[0]?.total ?? 0) };
    },

    async search(p, shop) {
      // without a letter or digit there is no trigram, so nothing can match; skip the (sequential) scan
      if (!/[\p{L}\p{N}]/u.test(p.text)) return [];
      const [, rows] = await db.transaction([
        { text: `select set_config('pg_trgm.word_similarity_threshold', $1, true)`, params: [WORD_SIMILARITY] },
        {
          // Only trusted rows group (Ruling R30, final review I1): a title-only match is its own result and never
          // pulls another shop's row into a hit. Groups follow their best hit's rank, and carry its title.
          // A row is found by its shop title or its clean name; ranking uses the clean name first, then the title
          // (design Part 3). Each side is found through its own trigram index.
          text: `with cand as (
            select sp.id from site_products sp where $1 <% sp.title
            union
            select sp.id from product_names pn
            join site_products sp on sp.shop_id = pn.shop_id and sp.group_key = pn.group_key and pn.source_title = sp.title
            where pn.status = 'ok' and $1 <% pn.display_name
          ), hits as (
            select sp.id, coalesce(pn.display_name, sp.title) as title, sp.canonical_id, ${TRUSTED} as trusted,
              case when ${TRUSTED} then 'c' || sp.canonical_id else 's' || sp.id end as group_key,
              row_number() over (
                order by coalesce(pn.display_name, sp.title) ilike $2 desc, word_similarity($1, coalesce(pn.display_name, sp.title)) desc,
                  sp.title ilike $2 desc, word_similarity($1, sp.title) desc, similarity($1, sp.title) desc,
                  nullif(sp.price_cents, 0) asc nulls last, sp.id
              ) as hit_rank
            from cand join site_products sp on sp.id = cand.id join shops s on s.id = sp.shop_id
            ${NAME_JOIN}
            where ${VISIBLE} and ($3::text is null or s.slug = $3)
            order by hit_rank
            limit ${SEARCH_HITS}
          ), grp as (
            select distinct on (group_key) group_key, hit_rank, id as hit_id, title as group_title, canonical_id, trusted
            from hits
            order by group_key, hit_rank
          ), top as (
            select * from grp order by hit_rank limit ${SEARCH_GROUPS}
          ), members as (
            select t.group_key, t.hit_rank, t.group_title, sp.id
            from top t join site_products sp on sp.canonical_id = t.canonical_id
            where t.trusted and ${TRUSTED}
            union
            select t.group_key, t.hit_rank, t.group_title, t.hit_id from top t where not t.trusted
          ), ranked as (
            select m.group_key, m.hit_rank, m.group_title, ${CARD_COLUMNS}, sp.in_stock, sp.canonical_id, sp.match_method,
              sp.match_confirmed, sp.image_url, pn.display_name, pn.variant_label, pn.category as name_category, pn.attrs,
              -- a stored 0 is no price (serialised null): it sorts with the nulls, last
              row_number() over (partition by m.group_key order by nullif(sp.price_cents, 0) asc nulls last, sp.id) as rn
            from members m join site_products sp on sp.id = m.id join shops s on s.id = sp.shop_id
            ${NAME_JOIN}
            where ${VISIBLE} and ($3::text is null or s.slug = $3)
          ), agg as (
            -- the whole product, also past the rows listed below (review: shop counts are not capped)
            select m.group_key, count(distinct sp.shop_id)::int as group_shops, bool_or(sp.bf_status = 'marked') as group_bf,
              count(*) filter (where sp.verdict = 'good')::int as group_good, count(*) filter (where sp.verdict = 'avoid')::int as group_avoid,
              min(sp.price_cents) filter (where sp.price_cents > 0 and sp.in_stock is distinct from false) as group_low_in_stock,
              min(sp.price_cents) filter (where sp.price_cents > 0) as group_low
            from members m join site_products sp on sp.id = m.id join shops s on s.id = sp.shop_id
            where ${VISIBLE} and ($3::text is null or s.slug = $3)
            group by m.group_key
          )
          select ranked.*, agg.group_shops, agg.group_bf, agg.group_good, agg.group_avoid, agg.group_low_in_stock, agg.group_low
          from ranked join agg on agg.group_key = ranked.group_key
          where rn <= ${searchMembers}
          order by hit_rank, rn`,
          params: [p.text, p.like, shop],
        },
      ]);
      // groups hold trusted rows only, so no row of a search group is "possibly the same"; an untrusted row is
      // alone in its group (its canonical id is not shown, so nothing links it to the title-only match)
      return rows.map((r) => {
        const groupKey = String(r.group_key);
        const trusted = trustedMatch(strOrNull(r.match_method), Boolean(r.match_confirmed));
        return {
          ...toCard(r),
          groupKey,
          groupTitle: String(r.group_title),
          canonicalId: groupKey.startsWith('c') ? numOrNull(r.canonical_id) : null,
          possible: groupKey.startsWith('c') && !trusted,
          inStock: boolOrNull(r.in_stock),
          displayName: strOrNull(r.display_name),
          variantLabel: strOrNull(r.variant_label),
          nameCategory: strOrNull(r.name_category),
          attrs: objOrNull(r.attrs),
          imageUrl: strOrNull(r.image_url),
          groupShops: num(r.group_shops),
          groupBf: r.group_bf === true,
          groupGood: num(r.group_good),
          groupAvoid: num(r.group_avoid),
          groupLowInStock: priceOrNull(r.group_low_in_stock),
          groupLow: priceOrNull(r.group_low),
        };
      });
    },

    async shops() {
      const rows = await db.query(
        `select s.slug, s.name, r.grade, count(sp.id)::int as products
        from shops s
        join site_products sp on sp.shop_id = s.id and sp.updated_at > now() - interval '2 days'
        left join shop_ratings r on r.shop_id = s.id
        where s.active and not s.site_hidden
        group by s.id, s.slug, s.name, r.grade
        order by lower(s.name), s.slug`,
        [],
      );
      return rows.map((r) => ({ slug: String(r.slug), name: String(r.name), grade: (r.grade ?? null) as Grade | null, products: num(r.products) }));
    },

    async shop(slug) {
      const rows = await db.query(
        `select s.id, s.slug, s.name, s.base_url, s.category, r.grade, r.sentence, r.judged as rating_judged, st.*
        from shops s
        left join shop_ratings r on r.shop_id = s.id
        cross join lateral (
          select count(*)::int as products,
            count(*) filter (where ${JUDGED_SQL})::int as judged,
            count(*) filter (where sp.verdict = 'good' and sp.price_cents > 0)::int as good,
            count(*) filter (where sp.verdict = 'avoid')::int as avoid,
            count(*) filter (where sp.verdict in ('good', 'avoid') and sp.facts -> 'wasRaisedFrom' is not null)::int as was_raised,
            count(*) filter (where sp.bf_status = 'marked')::int as bf_marked
          from site_products sp where sp.shop_id = s.id and sp.updated_at > now() - interval '2 days'
        ) st
        where s.slug = $1 and s.active and not s.site_hidden`,
        [slug],
      );
      const r = rows[0];
      if (!r) return null;
      const judged = num(r.judged);
      return {
        shop: { id: num(r.id), slug: String(r.slug), name: String(r.name), url: String(r.base_url), category: strOrNull(r.category) },
        rating: r.sentence === null || r.sentence === undefined ? null : { grade: (r.grade ?? null) as Grade | null, sentence: String(r.sentence), judged: num(r.rating_judged) },
        stats: {
          products: num(r.products),
          judged,
          good: num(r.good),
          avoid: num(r.avoid),
          wasRaised: num(r.was_raised),
          bfMarked: num(r.bf_marked),
          realDealPct: judged > 0 ? Math.round((1000 * num(r.good)) / judged) / 10 : null,
        },
      };
    },

    async shopChanges(shopId, days) {
      const rows = await db.query(
        `with g as (
          select sp.id, sp.rep_product_id, sp.title
          from site_products sp join shops s on s.id = sp.shop_id
          where sp.shop_id = $1 and ${VISIBLE} and sp.rep_product_id is not null
        ), changes as (
          -- per group two short index range scans (primary key product_id, observed_at): cost follows the
          -- shop's size, not the length of the price history
          select g.id, g.title, p.price_cents as from_cents, l.price_cents as to_cents, p.observed_at as from_at, l.observed_at as at,
            round(100.0 * (l.price_cents - p.price_cents) / p.price_cents, 1)::float8 as pct
          from g
          cross join lateral (
            select po.price_cents, po.observed_at from price_observations po
            where po.product_id = g.rep_product_id and po.observed_at > now() - make_interval(days => $2::int)
              and po.price_cents > 0 and po.review_flag is null
            order by po.observed_at desc limit 1
          ) l
          cross join lateral (
            select po.price_cents, po.observed_at from price_observations po
            where po.product_id = g.rep_product_id and po.observed_at > now() - make_interval(days => $2::int)
              and po.observed_at < l.observed_at and po.price_cents > 0 and po.review_flag is null and po.price_cents <> l.price_cents
            order by po.observed_at desc limit 1
          ) p
        )
        (select 'rise' as kind, * from changes where pct > 0 order by pct desc, id limit ${CHANGES_EACH})
        union all
        (select 'drop' as kind, * from changes where pct < 0 order by pct asc, id limit ${CHANGES_EACH})`,
        [shopId, days],
      );
      return { rises: rows.filter((r) => r.kind === 'rise').map(toChange), drops: rows.filter((r) => r.kind === 'drop').map(toChange) };
    },

    async product(id) {
      const rows = await db.query(
        `select sp.id, sp.rep_product_id, sp.shop_id, sp.group_key, sp.title, sp.brand, sp.url, sp.image_url, sp.category,
          sp.variant_count, sp.price_cents, sp.was_price_cents, sp.in_stock, sp.bf_status, sp.verdict, sp.reason, sp.facts,
          sp.canonical_id, sp.match_method, sp.match_confirmed, s.name as shop, s.slug as shop_slug
        from site_products sp join shops s on s.id = sp.shop_id
        where sp.id = $1 and ${VISIBLE}`,
        [id],
      );
      const r = rows[0];
      if (!r) return null;
      const product: ProductInfo = {
        id: num(r.id),
        key: productKey(num(r.id), numOrNull(r.canonical_id), strOrNull(r.match_method), Boolean(r.match_confirmed)),
        productId: numOrNull(r.rep_product_id),
        title: String(r.title),
        brand: strOrNull(r.brand),
        url: strOrNull(r.url),
        imageUrl: strOrNull(r.image_url),
        category: strOrNull(r.category),
        shopId: num(r.shop_id),
        shop: String(r.shop),
        shopSlug: String(r.shop_slug),
        priceCents: priceOrNull(r.price_cents),
        wasCents: priceOrNull(r.was_price_cents),
        inStock: boolOrNull(r.in_stock),
        bf: r.bf_status === 'marked',
        variantCount: num(r.variant_count),
        canonicalId: numOrNull(r.canonical_id),
        matchMethod: strOrNull(r.match_method),
        matchConfirmed: Boolean(r.match_confirmed),
        verdict: r.verdict as Label,
        reason: strOrNull(r.reason),
        facts: (r.facts ?? null) as VerdictFacts | null,
      };
      const groupKey = String(r.group_key);
      const productTrusted = trustedMatch(product.matchMethod, product.matchConfirmed);

      const [variantRows, historyRows, otherRows] = await Promise.all([
        db.query(
          `select p.id, p.title, p.variant_title, lo.price_cents, lo.in_stock
          from products p
          left join lateral (
            select po.price_cents, po.in_stock from price_observations po
            where po.product_id = p.id and (po.review_flag is null or po.review_flag <> 'jump_70pct')
            order by po.observed_at desc limit 1
          ) lo on true
          where p.shop_id = $1 and coalesce(p.parent_external_id, p.external_id) = $2
          order by p.id
          limit ${VARIANTS_MAX}`,
          [product.shopId, groupKey],
        ),
        // a wide group can exceed the cap: keep the newest points, then return them oldest first
        db.query(
          `select * from (
            select po.product_id, po.observed_at, po.price_cents, po.was_price_cents, po.in_stock,
              coalesce(po.bf_marked, coalesce(p.bf_status = 'marked', false)) as bf
            from products p join price_observations po on po.product_id = p.id
            where p.shop_id = $1 and coalesce(p.parent_external_id, p.external_id) = $2
              and po.observed_at > now() - interval '${HISTORY_DAYS} days'
              -- unchecked 70% jumps are left out, as the verdicts leave them out (Ruling R55)
              and (po.review_flag is null or po.review_flag <> 'jump_70pct')
            order by po.observed_at desc, po.product_id desc
            limit $3
          ) h
          order by observed_at, product_id`,
          [product.shopId, groupKey, historyMax],
        ),
        product.canonicalId === null
          ? Promise.resolve([] as Row[])
          : db.query(
              `select sp.id, sp.title, s.name as shop, s.slug as shop_slug, sp.price_cents, sp.in_stock, sp.verdict,
                sp.match_method, sp.match_confirmed
              from site_products sp join shops s on s.id = sp.shop_id
              where sp.canonical_id = $1 and sp.shop_id <> $2 and ${VISIBLE}
              order by nullif(sp.price_cents, 0) asc nulls last, sp.id
              limit ${OTHERS_MAX}`,
              [product.canonicalId, product.shopId],
            ),
      ]);

      return {
        product,
        variants: variantRows.map((v) => ({
          id: num(v.id),
          title: strOrNull(v.title),
          variantTitle: strOrNull(v.variant_title),
          priceCents: priceOrNull(v.price_cents),
          inStock: boolOrNull(v.in_stock),
        })),
        history: historyRows.map((h) => ({
          productId: num(h.product_id),
          at: iso(h.observed_at),
          price: priceOrNull(h.price_cents),
          was: priceOrNull(h.was_price_cents),
          inStock: boolOrNull(h.in_stock),
          bf: boolOrNull(h.bf),
        })),
        others: otherRows.map((o) => ({
          id: num(o.id),
          title: String(o.title),
          shop: String(o.shop),
          shopSlug: String(o.shop_slug),
          priceCents: priceOrNull(o.price_cents),
          inStock: boolOrNull(o.in_stock),
          verdict: o.verdict as Label,
          matchMethod: strOrNull(o.match_method),
          // both rows must be exact matches for a public "same product" claim
          possible: !(productTrusted && trustedMatch(strOrNull(o.match_method), Boolean(o.match_confirmed))),
        })),
      };
    },

    productGroup: (key) => loadGroup(key, true),

    async categories() {
      const rows = await db.query(
        `select coalesce(sp.category, '') as category, count(*)::int as count,
          count(*) filter (where sp.verdict = 'good' and sp.price_cents > 0)::int as good,
          count(*) filter (where sp.verdict = 'avoid')::int as avoid
        from site_products sp join shops s on s.id = sp.shop_id
        where ${VISIBLE}
        group by 1`,
        [],
      );
      return rows.map((r) => ({ slug: String(r.category), count: num(r.count), good: num(r.good), avoid: num(r.avoid) }));
    },
  };
}

/** The production Data: Neon over HTTP with the read-only role. */
export function neonData(databaseUrl: string): Data {
  return createData(neonRunner(databaseUrl));
}
