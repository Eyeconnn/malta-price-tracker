-- 017: the size of a shop's stored logo copy (pnpm fetch-logos), so the site can draw a wide wordmark as a pill and a
-- square logo as a circle. Safe to run again. null: unknown (logos stored before this migration), drawn as a circle.
alter table shops
  add column if not exists logo_w integer,
  add column if not exists logo_h integer;
