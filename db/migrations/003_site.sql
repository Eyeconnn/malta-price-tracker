-- 003: public site. Denormalised product table built nightly, shop ratings, visitor reports and site settings.
-- Additive only; the one change to an existing table is shops.site_hidden.

alter table shops add column site_hidden boolean not null default false;

-- one row per top-level setting (public, thresholds, phrases, categoryOverrides); missing keys use code defaults
create table site_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- one row per parent product (variants grouped) per shop
create table site_products (
  id             bigserial primary key,
  shop_id        integer not null references shops(id),
  group_key      text not null,
  title          text not null,
  brand          text,
  url            text,
  image_url      text,
  category       text,
  variant_count  integer not null default 1,
  rep_product_id bigint,
  gtin           text,
  mpn            text,
  price_cents    integer,
  was_price_cents integer,
  in_stock       boolean,
  bf_status      text,
  verdict        text not null check (verdict in ('good', 'avoid', 'none', 'insufficient')),
  reason         text,
  facts          jsonb,
  canonical_id   bigint,
  match_method   text,
  match_confirmed boolean not null default false,
  updated_at     timestamptz not null default now(),
  unique (shop_id, group_key)
);

create index site_products_verdict_category_idx on site_products (verdict, category);
create index site_products_canonical_idx on site_products (canonical_id);
create index site_products_title_trgm_idx on site_products using gin (title gin_trgm_ops);

create table shop_ratings (
  shop_id      integer primary key references shops(id),
  grade        text check (grade in ('A', 'B', 'C', 'D', 'E', 'F')),
  judged       integer not null default 0,
  good         integer not null default 0,
  avoid        integer not null default 0,
  was_raised   integer not null default 0,
  sentence     text,
  computed_at  timestamptz not null default now()
);

-- visitor reports about a product, a shop or a match
create table reports (
  id           bigserial primary key,
  target_type  text not null check (target_type in ('product', 'shop', 'match')),
  target_id    bigint not null,
  reason       text,
  message      text,
  email        text,
  ip_hash      text,
  status       text not null default 'open' check (status in ('open', 'fixed', 'kept', 'hidden')),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  admin_note   text
);

create index reports_status_idx on reports (status, created_at);
