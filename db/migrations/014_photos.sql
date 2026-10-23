-- 014: product photos from our own small copies in R2 (owner decision 23 Oct: never hot-linked from shops).
-- Safe to run again.
-- site_products.image_key: the R2 key (img/<sha256>.webp) of the group's stored copy, from the shown variant's
-- picture, else the representative's, else any variant's; null when none is stored. The site serves it at /<key>.
alter table site_products add column if not exists image_key text;

-- The image rows that failed only because the R2 key was read-only (or otherwise refused by R2) are cleared so the
-- URLs are tried again on the next run. Real fetch failures (HTTP status, host not allowed, not an image) stay.
-- Products linked to such a row are unlinked first (products.image_id references images).
update products set image_id = null
where image_id in (
  select id from images
  where r2_key is null and error is not null
    and (error like 'R2%' or error ilike '%AccessDenied%' or error ilike '%Access Denied%'
         or error ilike '%InvalidAccessKeyId%' or error ilike '%SignatureDoesNotMatch%'));

delete from images
where r2_key is null and error is not null
  and (error like 'R2%' or error ilike '%AccessDenied%' or error ilike '%Access Denied%'
       or error ilike '%InvalidAccessKeyId%' or error ilike '%SignatureDoesNotMatch%');
