-- 008: the --effort level a name normaliser run passed to claude (null: the CLI default). Additive only.
alter table name_runs add column if not exists effort text;
