-- 011: stable product links (review I4). When the site build removes a canonical product whose listings now belong
-- to another one (they gained a barcode, a name group re-formed), it records where they went, so an old
-- /product/c<id> link opens the product its listings moved to. Additive only; the site build and the read API work
-- without the table (no redirects) until this runs.

create table if not exists canonical_redirects (
  old_id      bigint primary key,
  new_id      bigint not null,
  created_at  timestamptz not null default now()
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dashboard_ro') then
    grant select on canonical_redirects to dashboard_ro;
  end if;
end
$$;
