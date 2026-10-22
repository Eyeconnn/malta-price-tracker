// All SQL of the public read API. Reads use the read-only role (Env.DATABASE_URL = dashboard_ro).
// Every query shows only visible shops (active, not site_hidden) and site_products rows refreshed in the last
// 2 days (Rulings R21, R28). The SQL runs through a small runner so tests can use PGlite instead of Neon.
import { neon } from '@neondatabase/serverless';
import type { Grade } from '../../src/site/rating.js';
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
/** A search hit or a member of a hit's canonical group. groupKey is 'c<canonical_id>' or 's<site_products id>'. */
export type SearchHit = Card & { groupKey: string; canonicalId: number | null; possible: boolean };
export type GroupResult = { canonicalId: number | null; title: string; items: (Card & { possible: boolean })[] };

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
/** Latest price against the last different price in the last 14 days, of a group's shown variant. */
export type Change = { id: number; title: string; fromCents: number; toCents: number; pct: number; fromAt: string; at: string };

export type ProductInfo = {
  id: number;
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

export type DealsQuery = { verdict: 'good' | 'avoid'; category: string | null; shop: string | null; limit: number; offset: number };
export type CategoryCount = { slug: string; count: number; good: number; avoid: number };

export interface Data {
  settings(): Promise<SiteSettings>;
  /** good lists never include rows without a positive price */
  deals(q: DealsQuery): Promise<{ items: Card[]; total: number }>;
  /** hits ordered by group relevance (max 40 groups), plus the visible members of each hit's canonical group */
  search(p: SearchPattern, shop: string | null): Promise<SearchHit[]>;
  shops(): Promise<ShopSummary[]>;
  shop(slug: string): Promise<{ shop: ShopInfo; rating: ShopRating | null; stats: ShopStats } | null>;
  shopChanges(shopId: number): Promise<{ rises: Change[]; drops: Change[] }>;
  product(id: number): Promise<ProductDetail | null>;
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

const CARD_COLUMNS = `sp.id, sp.title, s.name as shop, s.slug as shop_slug, sp.price_cents, sp.was_price_cents, sp.verdict,
  sp.reason, sp.bf_status, sp.category, sp.facts -> 'raisedFrom' as raised_from, sp.facts ->> 'wasRaisedFrom' as was_raised_from`;

/** word_similarity threshold for `<%`, as in the dashboard search. */
const WORD_SIMILARITY = '0.5';
const HISTORY_DAYS = 60;
const CHANGE_DAYS = 14;
const CHANGES_EACH = 10;
const OTHERS_MAX = 30;
const VARIANTS_MAX = 200;
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

/** A row of a site_products group counts as exactly matched when matched by GTIN/MPN or confirmed by the admin. */
export function trustedMatch(method: string | null, confirmed: boolean): boolean {
  return method === 'gtin' || method === 'mpn' || confirmed;
}

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
};

export function createData(db: SqlRunner, opts: DataOptions = {}): Data {
  const historyMax = opts.historyMax ?? HISTORY_MAX;
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
        )
        select t.total, x.*
        from (select count(*)::int as total from f) t
        left join lateral (select * from f order by rank desc nulls last, id limit $4 offset $5) x on true`,
        [q.verdict, q.category, q.shop, q.limit, q.offset],
      );
      return { items: rows.filter((r) => r.id !== null && r.id !== undefined).map(toCard), total: num(rows[0]?.total ?? 0) };
    },

    async search(p, shop) {
      // without a letter or digit there is no trigram, so nothing can match; skip the (sequential) scan
      if (!/[\p{L}\p{N}]/u.test(p.text)) return [];
      const [, rows] = await db.transaction([
        { text: `select set_config('pg_trgm.word_similarity_threshold', $1, true)`, params: [WORD_SIMILARITY] },
        {
          text: `with hits as (
            select sp.id, sp.canonical_id, word_similarity($1, sp.title) as score, sp.title ilike $2 as exact
            from site_products sp join shops s on s.id = sp.shop_id
            where $1 <% sp.title and ${VISIBLE} and ($3::text is null or s.slug = $3)
            order by exact desc, score desc, sp.price_cents asc nulls last, sp.id
            limit ${SEARCH_HITS}
          ), grp as (
            select coalesce('c' || canonical_id, 's' || id) as group_key, max(canonical_id) as canonical_id,
              max(id) as hit_id, bool_or(exact) as exact, max(score) as score
            from hits group by 1
            order by exact desc, score desc, group_key
            limit ${SEARCH_GROUPS}
          ), members as (
            select g.group_key, g.exact, g.score, sp.id
            from grp g join site_products sp on sp.canonical_id = g.canonical_id
            where g.canonical_id is not null
            union
            select g.group_key, g.exact, g.score, g.hit_id from grp g where g.canonical_id is null
          ), ranked as (
            select m.group_key, m.exact, m.score, ${CARD_COLUMNS}, sp.canonical_id, sp.match_method, sp.match_confirmed,
              row_number() over (partition by m.group_key order by sp.price_cents asc nulls last, sp.id) as rn
            from members m join site_products sp on sp.id = m.id join shops s on s.id = sp.shop_id
            where ${VISIBLE} and ($3::text is null or s.slug = $3)
          )
          select * from ranked where rn <= ${GROUP_MEMBERS}
          order by exact desc, score desc, group_key, rn`,
          params: [p.text, p.like, shop],
        },
      ]);
      // a row of a canonical group is "possibly the same" unless its own match is exact (GTIN/MPN or confirmed)
      return rows.map((r) => ({
        ...toCard(r),
        groupKey: String(r.group_key),
        canonicalId: numOrNull(r.canonical_id),
        possible: r.canonical_id !== null && !trustedMatch(strOrNull(r.match_method), Boolean(r.match_confirmed)),
      }));
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
            count(*) filter (where sp.verdict in ('good', 'avoid'))::int as judged,
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

    async shopChanges(shopId) {
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
            where po.product_id = g.rep_product_id and po.observed_at > now() - interval '${CHANGE_DAYS} days'
              and po.price_cents > 0 and po.review_flag is null
            order by po.observed_at desc limit 1
          ) l
          cross join lateral (
            select po.price_cents, po.observed_at from price_observations po
            where po.product_id = g.rep_product_id and po.observed_at > now() - interval '${CHANGE_DAYS} days'
              and po.observed_at < l.observed_at and po.price_cents > 0 and po.review_flag is null and po.price_cents <> l.price_cents
            order by po.observed_at desc limit 1
          ) p
        )
        (select 'rise' as kind, * from changes where pct > 0 order by pct desc, id limit ${CHANGES_EACH})
        union all
        (select 'drop' as kind, * from changes where pct < 0 order by pct asc, id limit ${CHANGES_EACH})`,
        [shopId],
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
            where po.product_id = p.id order by po.observed_at desc limit 1
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
              order by sp.price_cents asc nulls last, sp.id
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

    async categories() {
      const rows = await db.query(
        `select sp.category, count(*)::int as count,
          count(*) filter (where sp.verdict = 'good' and sp.price_cents > 0)::int as good,
          count(*) filter (where sp.verdict = 'avoid')::int as avoid
        from site_products sp join shops s on s.id = sp.shop_id
        where ${VISIBLE} and sp.category is not null
        group by sp.category`,
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
