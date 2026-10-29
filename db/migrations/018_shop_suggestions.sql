-- 018: visitors suggest shops (Suggest a shop on /shops, owner request 29 Oct 2026). A suggestion is a shop
-- request like one from the admin Add shop page and is checked by the same PC task; a shop that passes goes live
-- on its own. Visitors are told why a shop cannot be tracked through a short reason code (src/shop-requests/reasons.ts).

-- why a switched-off shop is off, for visitors (set from shops.seed.json); null: no public reason
alter table shops add column if not exists unavailable_reason text
  check (unavailable_reason in ('robots', 'bot_protection', 'crawl_delay', 'rate_limited', 'not_readable', 'not_found', 'needs_setup', 'declined'));

-- why a check did not add the shop, set by the PC task with the status; null for active, pending and internal errors
alter table shop_requests add column if not exists reason text
  check (reason in ('robots', 'bot_protection', 'crawl_delay', 'rate_limited', 'not_readable', 'not_found', 'needs_setup', 'declined'));
-- who asked: the owner on the admin page or a visitor on the public site
alter table shop_requests add column if not exists source text not null default 'admin' check (source in ('admin', 'visitor'));
-- a visitor's salted IP hash (as reports.ip_hash), for the per-network limit; null for the owner's requests
alter table shop_requests add column if not exists ip_hash text;
create index if not exists shop_requests_ip_idx on shop_requests (ip_hash, requested_at) where ip_hash is not null;

-- the requests checked before this migration
update shop_requests set reason = case
    when status = 'blocked' then 'robots'
    when status = 'needs_setup' and error like '%Crawl-delay%' then 'crawl_delay'
    when status = 'needs_setup' then 'needs_setup'
    when status = 'failed' and error ~ 'HTTP (202|401|403)' then 'bot_protection'
    when status = 'failed' and error like 'Rate-limited repeatedly%' then 'rate_limited'
    when status = 'failed' and (error like 'No products were read%' or error like 'Only % products%' or error ~ '^\d+ of \d+ requests failed') then 'not_readable'
    when status = 'failed' and error like 'The home page%' then 'not_found'
  end
  where reason is null and status in ('blocked', 'needs_setup', 'failed');

-- The public site's reporter role may look a suggested address up (shops and open requests, public columns only),
-- add a visitor suggestion and count its network's recent ones. Nothing else on these tables.
-- The same grants are in scripts/create-site-roles.ts so a re-run keeps them.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'site_reporter') then
    grant select (id, slug, name, base_url, active, site_hidden, unavailable_reason) on shops to site_reporter;
    grant select (id, origin, status, reason, source, ip_hash, requested_at) on shop_requests to site_reporter;
    grant insert (origin, display_name, source, ip_hash) on shop_requests to site_reporter;
    grant usage on sequence shop_requests_id_seq to site_reporter;
  end if;
end
$$;
