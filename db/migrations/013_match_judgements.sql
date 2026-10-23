-- 013: product matching by Claude judging candidate groups side by side (design "Update 23 Oct, afternoon").
-- Additive only, safe to run again: two new tables.
-- judge_runs: one row per pnpm judge-matches run with its usage (like name_runs).
-- match_judgements: one row per candidate group (candidate_key: which listings), with its members, a fingerprint of
-- their titles and variant titles, and the verdict: Claude's clusters of listings judged the same product, the
-- differences it listed between clusters, the pairs the veto in code overruled and the clusters left after the veto.
-- The site build (JUDGED_MATCHING on) groups a judgement's clusters only while its fingerprint is current.

create table if not exists judge_runs (
  id                  bigserial primary key,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  model               text not null,
  effort              text,
  pilot               boolean not null default false,
  dry_run             boolean not null default false,
  batches             integer not null default 0,
  groups              integer not null default 0,
  judged              integer not null default 0,
  rejected            integer not null default 0,
  matched             integer not null default 0,
  vetoes              integer not null default 0,
  failed_batches      integer not null default 0,
  input_tokens        bigint not null default 0,
  output_tokens       bigint not null default 0,
  cache_read_tokens   bigint not null default 0,
  cache_write_tokens  bigint not null default 0,
  thinking_tokens     bigint not null default 0,
  -- total_cost_usd as Claude Code reports it (API prices; on a plan it is what the run would have cost)
  reported_cost_usd   numeric(12, 6),
  report_path         text
);

create table if not exists match_judgements (
  id             bigserial primary key,
  candidate_key  text not null unique,
  -- [{ "shop_id": 1, "group_key": "...", "site_product_id": 123 }, ...] in the order the verdict's indexes use
  members        jsonb not null,
  fingerprint    text not null,
  -- { "clusters": [[0, 2], [1]], "apart": [{ "a": 0, "b": 1, "differences": ["..."] }],
  --   "vetoed": [{ "a": 0, "b": 2, "reasons": ["..."] }], "final": [[0, 2]] }
  verdict        jsonb not null,
  model          text not null,
  effort         text,
  judged_at      timestamptz not null default now(),
  run_id         bigint not null references judge_runs(id)
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dashboard_ro') then
    grant select on match_judgements, judge_runs to dashboard_ro;
  end if;
end
$$;
