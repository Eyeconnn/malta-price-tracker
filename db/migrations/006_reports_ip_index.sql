-- 006: the report rate limit counts rows per ip_hash in the last hour (web/worker/reports.ts); index that lookup.
create index if not exists reports_ip_created_idx on reports (ip_hash, created_at);
