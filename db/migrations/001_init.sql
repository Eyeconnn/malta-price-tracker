-- 001: initial schema for the Malta Black Friday price tracker.
-- Prices are integer euro cents everywhere.

create extension if not exists pg_trgm;

create table shops (
  id          serial primary key,
  slug        text not null unique,
  name        text not null,
  base_url    text not null,
  category    text,
  adapter     text not null check (adapter in ('woo', 'shopify', 'magento', 'html', 'headless', 'snapshot')),
  config      jsonb not null default '{}'::jsonb,
  tier        text not null default 'P1' check (tier in ('P1', 'P2', 'P3')),
  active      boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table scrape_runs (
  id               bigserial primary key,
  shop_id          integer not null references shops(id),
  kind             text not null default 'full' check (kind in ('full', 'due')),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  -- null while the run is in progress
  status           text check (status in ('ok', 'partial', 'failed')),
  products_seen    integer not null default 0,
  requests         integer not null default 0,
  failed_requests  integer not null default 0,
  disallowed       integer not null default 0,
  errors           integer not null default 0,
  error_log        jsonb not null default '[]'::jsonb,
  notes            text
);
create index scrape_runs_shop_started_idx on scrape_runs (shop_id, started_at desc);

create table images (
  id          bigserial primary key,
  source_url  text not null unique,
  r2_key      text,
  sha256      text,
  phash       text,
  width       integer,
  height      integer,
  content_type text,
  bytes       integer,
  error       text,
  created_at  timestamptz not null default now()
);
create index images_sha256_idx on images (sha256);

create table canonical_products (
  id          bigserial primary key,
  title       text not null,
  brand       text,
  gtin        text,
  mpn         text,
  created_at  timestamptz not null default now()
);
create index canonical_products_gtin_idx on canonical_products (gtin);

create table products (
  id                  bigserial primary key,
  shop_id             integer not null references shops(id),
  external_id         text not null,
  -- parent product id for variants (Shopify product id, Woo parent id)
  parent_external_id  text,
  url                 text,
  sku                 text,
  gtin                text,
  mpn                 text,
  brand               text,
  title               text,
  variant_title       text,
  category_path       text,
  tags                text[],
  image_url           text,
  image_id            bigint references images(id),
  shop_created_at     timestamptz,
  first_seen          timestamptz not null default now(),
  last_seen           timestamptz not null default now(),
  canonical_id        bigint references canonical_products(id),
  watch_tier          text not null default 'normal' check (watch_tier in ('normal', 'warm', 'hot')),
  next_check_at       timestamptz,
  -- adapter specific data needed to re-read one product cheaply (handle, ids)
  meta                jsonb not null default '{}'::jsonb,
  unique (shop_id, external_id)
);
create index products_gtin_idx on products (gtin) where gtin is not null;
create index products_mpn_idx on products (mpn) where mpn is not null;
create index products_shop_next_check_idx on products (shop_id, next_check_at);
create index products_title_trgm_idx on products using gin (title gin_trgm_ops);

create table price_observations (
  product_id          bigint not null references products(id),
  observed_at         timestamptz not null,
  run_id              bigint references scrape_runs(id),
  price_cents         integer,
  was_price_cents     integer,
  -- the shop's own printed EU "lowest price in the last 30 days" (e.g. Decathlon)
  shop_30d_low_cents  integer,
  in_stock            boolean,
  on_sale             boolean,
  badge_text          text,
  raw_hash            text,
  -- set when the row should not be trusted without review (zero_price, missing_price, jump_70pct)
  review_flag         text,
  primary key (product_id, observed_at)
);
create index price_observations_run_idx on price_observations (run_id);
create index price_observations_flag_idx on price_observations (review_flag) where review_flag is not null;

create table product_matches (
  product_id    bigint not null references products(id),
  canonical_id  bigint not null references canonical_products(id),
  method        text not null check (method in ('gtin', 'mpn', 'fuzzy', 'image', 'manual')),
  confidence    numeric(4, 3),
  confirmed     boolean not null default false,
  created_at    timestamptz not null default now(),
  primary key (product_id, canonical_id)
);

create table promotions (
  id               bigserial primary key,
  shop_id          integer references shops(id),
  title            text,
  promo_type       text check (promo_type in ('sitewide_pct', 'category_pct', 'product_prices', 'bundle_gift', 'voucher', 'code', 'free_shipping')),
  headline_claim   text,
  claimed_pct_max  numeric(5, 2),
  code             text,
  starts_on        date,
  ends_on          date,
  first_seen       timestamptz not null default now(),
  last_seen        timestamptz not null default now(),
  source_kind      text check (source_kind in ('collection', 'category', 'page', 'homepage', 'portal', 'tag', 'social', 'manual')),
  source_url       text,
  terms            text,
  exclusions       text,
  status           text not null default 'detected' check (status in ('detected', 'confirmed', 'active', 'ended', 'dismissed'))
);
create index promotions_shop_idx on promotions (shop_id, status);

create table promotion_products (
  promotion_id  bigint not null references promotions(id),
  product_id    bigint not null references products(id),
  link_method   text,
  primary key (promotion_id, product_id)
);
create index promotion_products_product_idx on promotion_products (product_id);

create table promotion_evidence (
  id            bigserial primary key,
  promotion_id  bigint not null references promotions(id),
  captured_at   timestamptz not null default now(),
  kind          text not null check (kind in ('html', 'screenshot', 'upload')),
  r2_key        text,
  sha256        text,
  source_url    text
);

create table verdicts (
  id                    bigserial primary key,
  product_id            bigint not null references products(id),
  promotion_id          bigint references promotions(id),
  computed_at           timestamptz not null default now(),
  label                 text,
  badges                text[],
  price_cents           integer,
  was_price_cents       integer,
  low_30d_cents         integer,
  high_60d_cents        integer,
  history_days          integer,
  claimed_pct           numeric(5, 2),
  real_pct              numeric(5, 2),
  cheapest_other_cents  integer,
  cheapest_other_shop   text
);
create index verdicts_product_idx on verdicts (product_id, computed_at desc);

-- Raw HTML snapshots (Black Friday pages etc.), stored in R2.
create table snapshots (
  id           bigserial primary key,
  shop_id      integer references shops(id),
  url          text not null,
  captured_at  timestamptz not null default now(),
  http_status  integer,
  r2_key       text,
  sha256       text,
  bytes        integer
);
create index snapshots_url_idx on snapshots (url, captured_at desc);
