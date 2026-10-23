-- 009: shops requested from the admin area (Add shop page). The Worker stores the address; the PC task
-- (pnpm shop-requests, Windows task "MTP Shop Requests", every 15 minutes) checks robots.txt, detects the
-- platform, creates an inactive shop, runs a test scrape and activates it when it passes.
-- Numbered 009 so it cannot clash with 007 and 008 on another branch.

create table shop_requests (
  id              bigserial primary key,
  -- scheme, host and non-default port only (e.g. https://example.com.mt), checked by the Worker
  origin          text not null,
  display_name    text,
  shop_category   text,
  status          text not null default 'pending'
                  check (status in ('pending', 'checking', 'active', 'needs_setup', 'blocked', 'failed', 'rejected')),
  requested_at    timestamptz not null default now(),
  -- when the current or last check began (a check stuck for over an hour is reset to failed)
  started_at      timestamptz,
  checked_at      timestamptz,
  -- shopify, woocommerce, magento-graphql, magento-html or unknown
  platform        text,
  -- { status, allowed, crawlDelaySeconds, checked: [{ path, allowed, rule }], blockedBy }
  robots          jsonb,
  products_found  integer,
  -- up to 10 test-scrape products: [{ title, priceCents, url }], prices in integer cents
  sample          jsonb,
  -- what was found on an unsupported shop (server, generator, JSON-LD, category links)
  details         jsonb,
  error           text,
  shop_id         integer references shops(id),
  attempts        integer not null default 0
);

-- one open request per origin; a rejected request does not stop the address being added again
create unique index shop_requests_open_origin_idx on shop_requests (origin) where status <> 'rejected';
create index shop_requests_status_idx on shop_requests (status, requested_at);

-- The Worker's admin role may list requests, add one (address, name, category only) and change only its
-- status (retry, reject). The same grants are in scripts/create-site-roles.ts so a re-run keeps them.
-- The read-only role of the public site gets nothing.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'site_admin') then
    grant select on shop_requests to site_admin;
    grant insert (origin, display_name, shop_category) on shop_requests to site_admin;
    grant update (status) on shop_requests to site_admin;
    grant usage on sequence shop_requests_id_seq to site_admin;
  end if;
  if exists (select 1 from pg_roles where rolname = 'dashboard_ro') then
    revoke all on shop_requests from dashboard_ro;
    revoke all on sequence shop_requests_id_seq from dashboard_ro;
  end if;
end
$$;
