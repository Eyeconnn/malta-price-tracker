-- 005: site-build matching key for canonical products ('gtin:...', 'mpn:...', 'title:<site_products id>').
-- The nightly site-build upserts canonical_products by this key and points site_products.canonical_id at it.

alter table canonical_products add column match_key text unique;
