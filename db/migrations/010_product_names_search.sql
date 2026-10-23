-- 010: search by clean name (design Part 3). The public search finds a listing by its shop title or by its accepted
-- clean name (web/worker/data.ts search); this trigram index serves the clean-name side, as
-- site_products_title_trgm_idx serves the title side. Additive only; without it the clean-name side reads
-- product_names in full (small while the normaliser has named few groups).

create index if not exists product_names_display_trgm_idx on product_names using gin (display_name gin_trgm_ops) where status = 'ok';
