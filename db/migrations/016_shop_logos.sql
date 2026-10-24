-- 016: shop logos (pnpm fetch-logos, src/pipeline/logos.ts). Safe to run again.
--
-- logo_key         the R2 key of our small copy of the shop's logo (img/<sha256 of the original>.webp, at most 128 px,
--                  WebP with its transparency kept); the site serves it at /<key>. null: no logo, the initials show.
-- logo_checked_at  when the logo job last looked at the shop (found one or not). A shop is looked at again only when
--                  it has no logo and either was never checked, or its last check failed over 30 days ago, or the job
--                  runs with --retry.
-- logo_error       why the last check found no logo (null after a success).
alter table shops
  add column if not exists logo_key text,
  add column if not exists logo_checked_at timestamptz,
  add column if not exists logo_error text;
