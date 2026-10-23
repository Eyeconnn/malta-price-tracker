-- 009: shops requested from the admin area (Add shop page). The Worker stores the address; the PC task
-- (pnpm shop-requests, Windows task "MTP Shop Requests", every 15 minutes) checks robots.txt, detects the
-- platform, creates an inactive shop, runs a test scrape and activates it when it passes.
-- Numbered 009 so it cannot clash with 007 and 008 on another branch.

create table if not exists shop_requests (
  id                  bigserial primary key,
  -- scheme and lowercase host only, never a port or path (e.g. https://example.com.mt), checked by the Worker
  origin              text not null check (origin ~ '^https?://[a-z0-9.-]+$'),
  display_name        text,
  shop_category       text,
  status              text not null default 'pending'
                      check (status in ('pending', 'checking', 'active', 'needs_setup', 'blocked', 'failed', 'rejected')),
  requested_at        timestamptz not null default now(),
  -- when the current or last check began (a check stuck for over an hour is reset to failed)
  started_at          timestamptz,
  checked_at          timestamptz,
  -- a pending request rate limited by the shop is not checked again before this time
  next_check_at       timestamptz,
  -- automatic retries after rate limiting so far (2 h, 8 h, 24 h; the fourth makes it failed)
  rate_limited_count  integer not null default 0,
  -- shopify, woocommerce, magento-graphql, magento-html or unknown
  platform            text,
  -- { status, allowed, crawlDelaySeconds, checked: [{ path, allowed, rule }], blockedBy }
  robots              jsonb,
  -- distinct products the test scrape read
  products_found      integer,
  -- up to 10 test-scrape products: [{ title, priceCents, url }], prices in integer cents
  sample              jsonb,
  -- what was found on an unsupported shop (server, generator, JSON-LD, category links, GraphQL error)
  details             jsonb,
  error               text,
  shop_id             integer references shops(id),
  attempts            integer not null default 0
);

-- one open request per shop host: lowercase (the check above) and without www., so www. and the apex are one
-- shop; a rejected request does not stop the address being added again
create unique index if not exists shop_requests_open_host_idx
  on shop_requests ((regexp_replace(origin, '^https?://(www\.)?', ''))) where status <> 'rejected';
create index if not exists shop_requests_queue_idx on shop_requests (status, next_check_at, requested_at);

-- A retry by the admin (failed or blocked back to pending; the Worker may change the status only) starts
-- the automatic rate-limit retries afresh.
create or replace function shop_requests_manual_retry() returns trigger language plpgsql as $$
begin
  if new.status = 'pending' and old.status in ('failed', 'blocked') then
    new.rate_limited_count := 0;
    new.next_check_at := null;
  end if;
  return new;
end
$$;
drop trigger if exists shop_requests_manual_retry on shop_requests;
create trigger shop_requests_manual_retry before update of status on shop_requests
  for each row execute function shop_requests_manual_retry();

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
