import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import sharp from 'sharp';
import { db } from '../db.js';
import { userAgent } from '../env.js';
import { ShopFetcher, scopeHost } from '../http/fetcher.js';
import { r2Configured, r2Writable, putObject } from '../r2.js';
import type { Shop } from '../types.js';
import { isPhotoKey, makeSmallCopy, photoKey } from './photo.js';

/** 64-bit difference hash (dHash) as 16 hex chars: 9x8 greyscale, compare horizontal neighbours. */
export async function dHash(buf: Buffer): Promise<string> {
  const px = await sharp(buf).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (px[y * 9 + x]! > px[y * 9 + x + 1]! ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

// Image hosts outside a shop's own domain that we accept. Others need the shop config key image_hosts.
const IMAGE_CDNS = ['cdn.shopify.com', 'i0.wp.com', 'i1.wp.com', 'i2.wp.com', 'cloudfront.net', 'cloudinary.com', 'imgix.net', 'wixstatic.com'];

// CDN hosts are shared by many shops: one fetcher per host for the whole process.
const cdnFetchers = new Map<string, ShopFetcher>();

function fetcherFor(url: string, shop: Shop, shopFetcher: ShopFetcher): ShopFetcher {
  const host = new URL(url).hostname;
  const scope = scopeHost(shop.base_url);
  if (host === scope || host.endsWith(`.${scope}`)) return shopFetcher;
  const allowed = [...IMAGE_CDNS, ...((shop.config.image_hosts as string[] | undefined) ?? [])];
  if (!allowed.some((h) => host === h || host.endsWith(`.${h}`))) throw new Error(`image host ${host} not in the allowlist`);
  let f = cdnFetchers.get(host);
  if (!f) {
    f = new ShopFetcher({ userAgent: userAgent(), allowedHosts: [host], minDelayMs: 300, maxDelayMs: 800, maxBodyBytes: 15 * 1024 * 1024 });
    cdnFetchers.set(host, f);
  }
  return f;
}

/** Only variants seen this recently are on the site, so only their groups get a photo. */
const RECENT_DAYS = 7;

export type ImageDeps = {
  sql: postgres.Sql;
  /** one image request (robots, delays and the host allowlist are the fetcher's) */
  fetchImage: (url: string) => Promise<{ status: number; body: Buffer }>;
  /** stores one object in R2 */
  put: (key: string, body: Buffer, contentType: string) => Promise<void>;
};

/** Points every product of the shop at the stored copy of its image URL; returns how many changed. */
async function linkProducts(sql: postgres.Sql, shopId: number): Promise<number> {
  const res = await sql`
    update products p set image_id = i.id from images i
    where p.shop_id = ${shopId} and p.image_url = i.source_url and i.r2_key like 'img/%' and p.image_id is distinct from i.id`;
  return res.count;
}

/**
 * The product groups of a shop (variants seen in the last 7 days, grouped as the site build groups them) that have
 * no stored photo yet, with the image URLs worth trying: the site row's own picture (site_products.image_url)
 * first, then the other variants' newest first. A URL is worth trying when it was never fetched, failed more than
 * 7 days ago (retried once a week), or was stored by the old pipeline as a full-size original (not an img/ key).
 * Black Friday marked groups first, then the most recently seen, so the useful photos arrive first.
 */
export async function photoCandidates(sql: postgres.Sql, shopId: number, limit: number): Promise<{ group_key: string; urls: string[] }[]> {
  return sql<{ group_key: string; urls: string[] }[]>`
    with v as (
      select coalesce(p.parent_external_id, p.external_id) as group_key, p.id, p.image_url, p.last_seen, p.bf_status,
        i.id as image_row, i.r2_key, i.created_at as tried_at
      from products p left join images i on i.source_url = p.image_url
      where p.shop_id = ${shopId} and p.last_seen > now() - make_interval(days => ${RECENT_DAYS})
    ), g as (
      select v.group_key,
        array_agg(v.image_url order by (v.image_url is not distinct from sp.image_url) desc, v.last_seen desc, v.id)
          filter (where v.image_url is not null and (v.image_row is null
            or (v.r2_key is null and v.tried_at < now() - interval '7 days')
            or (v.r2_key is not null and v.r2_key not like 'img/%'))) as urls,
        coalesce(sp.bf_status = 'marked', false) or coalesce(bool_or(v.bf_status = 'marked'), false) as bf,
        max(v.last_seen) as seen
      from v left join site_products sp on sp.shop_id = ${shopId} and sp.group_key = v.group_key
      group by v.group_key, sp.image_url, sp.bf_status
      having not coalesce(bool_or(v.r2_key like 'img/%'), false)
    )
    select group_key, urls from g where urls is not null
    order by bf desc, seen desc, group_key
    limit ${limit}`;
}

class StorageError extends Error {}

/**
 * Downloads one photo per product group (not per variant) within a per-run budget (config images_per_run, default
 * 300 image requests; config images_minutes, default 20). Groups and URLs come in photoCandidates order; a group
 * tries its next URL only when the one before failed. Only a small copy is stored (photo.ts: WebP, 480 px,
 * no metadata) under img/<sha256 of the original>.webp; the same original is stored once. An image URL is fetched
 * at most once: later products with the same URL are linked to the stored row.
 */
export async function downloadImagesForShop(shop: Shop, deps: Partial<ImageDeps> = {}): Promise<{ downloaded: number; linked: number }> {
  // off until switched on (IMAGES_ENABLED=on in scripts/run-local.ps1 and the scrape workflow)
  if (!/^(1|on|true|yes)$/i.test(process.env.IMAGES_ENABLED ?? '')) {
    console.log(`[${shop.slug}] images skipped: IMAGES_ENABLED is not on`);
    return { downloaded: 0, linked: 0 };
  }
  if (!deps.put && (!r2Configured() || !(await r2Writable()))) {
    console.log(`[${shop.slug}] images skipped: R2 is not configured or not writable`);
    return { downloaded: 0, linked: 0 };
  }
  const sql = deps.sql ?? db();
  const put = deps.put ?? putObject;
  let shopFetcher: ShopFetcher | undefined;
  const fetchImage =
    deps.fetchImage ??
    (async (url: string) => {
      shopFetcher ??= ShopFetcher.fromConfig(shop.config, userAgent(), shop.base_url, () => {});
      const res = await fetcherFor(url, shop, shopFetcher).get(url, { accept: 'image/avif,image/webp,image/*;q=0.8' });
      return { status: res.status, body: res.body };
    });

  const linked = await linkProducts(sql, shop.id);
  const budget = Number(shop.config.images_per_run ?? 300);
  const deadline = Date.now() + Number(shop.config.images_minutes ?? 20) * 60_000;
  const groups = await photoCandidates(sql, shop.id, budget);
  if (!groups.length) return { downloaded: 0, linked };

  /** One URL: fetched, made small, stored (unless the same original is stored already) and recorded. */
  async function store(url: string): Promise<void> {
    const res = await fetchImage(url);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const sha256 = createHash('sha256').update(res.body).digest('hex');
    const [existing] = await sql<{ r2_key: string; phash: string | null; width: number | null; height: number | null; bytes: number | null }[]>`
      select r2_key, phash, width, height, bytes from images where sha256 = ${sha256} and r2_key like 'img/%' limit 1`;
    let row = existing && isPhotoKey(existing.r2_key) ? existing : undefined;
    if (!row) {
      const copy = await makeSmallCopy(res.body);
      const key = photoKey(sha256);
      try {
        await put(key, copy.body, copy.contentType);
      } catch (e) {
        throw new StorageError((e as Error).message);
      }
      row = { r2_key: key, phash: await dHash(copy.body), width: copy.width, height: copy.height, bytes: copy.bytes };
    }
    await sql`
      insert into images (source_url, r2_key, sha256, phash, width, height, content_type, bytes)
      values (${url}, ${row.r2_key}, ${sha256}, ${row.phash}, ${row.width}, ${row.height}, 'image/webp', ${row.bytes})
      on conflict (source_url) do update set r2_key = excluded.r2_key, sha256 = excluded.sha256, phash = excluded.phash,
        width = excluded.width, height = excluded.height, content_type = excluded.content_type, bytes = excluded.bytes,
        error = null, created_at = now()`;
  }

  let downloaded = 0;
  let requests = 0;
  let failed = 0;
  // URLs tried in this run (several groups can share a picture): true when stored
  const tried = new Map<string, boolean>();
  run: for (const g of groups) {
    for (const url of new Set(g.urls)) {
      const before = tried.get(url);
      if (before === true) break;
      if (before === false) continue;
      if (requests >= budget || Date.now() > deadline) break run;
      requests++;
      try {
        await store(url);
        tried.set(url, true);
        downloaded++;
        break;
      } catch (e) {
        if (e instanceof StorageError) {
          console.error(`[${shop.slug}] R2 upload failed, stopping images for this run: ${e.message}`);
          break run;
        }
        tried.set(url, false);
        failed++;
        // remember the failure so the URL is not fetched again every night
        await sql`insert into images (source_url, error) values (${url}, ${(e as Error).message.slice(0, 300)})
                  on conflict (source_url) do update set error = excluded.error, created_at = now()`;
      }
    }
  }
  await linkProducts(sql, shop.id);
  console.log(`[${shop.slug}] images: ${downloaded} groups got a photo, ${failed} failed, ${requests} requests`);
  return { downloaded, linked };
}

/** Our photo copies in R2 for the daily summary: one object per stored key (several image URLs can share one). */
export async function photoStorage(sql: postgres.Sql): Promise<{ count: number; bytes: number }> {
  const [row] = await sql<{ count: number; bytes: string | null }[]>`
    select count(*)::int as count, coalesce(sum(bytes), 0)::text as bytes
    from (select distinct on (r2_key) r2_key, bytes from images where r2_key like 'img/%') x`;
  return { count: row?.count ?? 0, bytes: Number(row?.bytes ?? 0) };
}
