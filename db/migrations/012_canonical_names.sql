-- 012: canonical names (design "Update 23 Oct: match by canonical normalised names"). The normaliser writes the
-- canonical name of each accepted group, built by code from its identity fields; site-build matches listings whose
-- canonical names are exactly equal within one category (when name matching is switched on). Additive only;
-- nullable: names saved before get one in a catch-up run (pnpm normalise-names --backfill-canonical).

alter table product_names add column if not exists canonical_name text;
-- whether a canonical name was tried for the stored name: ok (canonical_name set), rejected (canonical_reason says
-- why), null (never tried: names saved before this migration). --backfill-canonical skips rejected ones unless
-- --retry-rejected.
alter table product_names add column if not exists canonical_status text check (canonical_status in ('ok', 'rejected'));
alter table product_names add column if not exists canonical_reason text;

create index if not exists product_names_canonical_idx on product_names (category, canonical_name) where canonical_name is not null;
