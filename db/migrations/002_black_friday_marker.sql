-- 002: whether a product is marked for Black Friday on the shop's site, and since when.
--
-- bf_status          marked   a current Black Friday marker (tag, category, collection, badge or title)
--                    excluded the shop marks it as not part of Black Friday (e.g. NOTINCBF25)
--                    stale    only a marker from a previous year (BF2025, CYBERMONDAY2024)
--                    null     no marker seen
-- bf_marker          what triggered the status, e.g. 'tag: BF2026', 'collection: Black Friday'
-- bf_first_marked_at first observation with a current marker
-- bf_last_marked_at  latest observation with a current marker
-- bf_preexisting     the marker was already there the first time we saw the product (start date unknown)

alter table products
  add column bf_status text check (bf_status in ('marked', 'excluded', 'stale')),
  add column bf_marker text,
  add column bf_first_marked_at timestamptz,
  add column bf_last_marked_at timestamptz,
  add column bf_preexisting boolean;

create index products_bf_idx on products (shop_id, bf_first_marked_at) where bf_status = 'marked';

-- per night: was a current marker present on this observation (null when unknown, e.g. partial re-reads)
alter table price_observations add column bf_marked boolean;
