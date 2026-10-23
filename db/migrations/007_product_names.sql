-- 007: clean product names from the name normaliser (pnpm normalise-names). Additive only: two new tables.
-- product_names: one row per site_products group (shop_id, group_key), normalised once and again only when the
-- shop's title fingerprint (title_hash) changes. name_runs: one row per normaliser run with its usage.

create table if not exists name_runs (
  id                  bigserial primary key,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  model               text not null,
  categories          text[] not null default '{}',
  pilot               boolean not null default false,
  dry_run             boolean not null default false,
  batches             integer not null default 0,
  items               integer not null default 0,
  accepted            integer not null default 0,
  rejected            integer not null default 0,
  failed_batches      integer not null default 0,
  input_tokens        bigint not null default 0,
  output_tokens       bigint not null default 0,
  cache_read_tokens   bigint not null default 0,
  cache_write_tokens  bigint not null default 0,
  -- total_cost_usd as Claude Code reports it (API prices; on a plan it is what the run would have cost)
  reported_cost_usd   numeric(12, 6),
  report_path         text
);

create table if not exists product_names (
  shop_id        integer not null references shops(id),
  group_key      text not null,
  source_title   text not null,
  title_hash     text not null,
  category       text,
  display_name   text,
  variant_label  text,
  attrs          jsonb not null default '{}'::jsonb,
  status         text not null check (status in ('ok', 'rejected')),
  reject_reason  text,
  model          text not null,
  run_id         bigint not null references name_runs(id),
  normalised_at  timestamptz not null default now(),
  primary key (shop_id, group_key)
);

-- the public site may read display names later
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dashboard_ro') then
    grant select on product_names, name_runs to dashboard_ro;
  end if;
end
$$;
