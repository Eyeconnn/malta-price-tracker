import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import sharp from 'sharp';
import { db } from '../db.js';
import { userAgent } from '../env.js';
import { OutOfScopeError, ShopAbortError, ShopFetcher, scopeHost } from '../http/fetcher.js';
import { r2Configured, r2Writable, putObject } from '../r2.js';
import type { Shop } from '../types.js';
import { MAX_IMAGE_BYTES, isPhotoKey, makeSmallCopy, photoKey } from './photo.js';

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
export const IMAGE_CDNS = ['cdn.shopify.com', 'i0.wp.com', 'i1.wp.com', 'i2.wp.com', 'cloudfront.net', 'cloudinary.com', 'imgix.net', 'wixstatic.com'];

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
    f = new ShopFetcher({ userAgent: userAgent(), allowedHosts: [host], minDelayMs: 300, maxDelayMs: 800, maxBodyBytes: MAX_IMAGE_BYTES });
    cdnFetchers.set(host, f);
  }
  return f;
}

/** The fetcher that would fetch url: 'shop' for the shop's own hosts, else the CDN host (one fetcher each). */
function fetcherName(url: string, shop: Shop): string {
  const host = new URL(url).hostname;
  const scope = scopeHost(shop.base_url);
  return host === scope || host.endsWith(`.${scope}`) ? 'shop' : host;
}

/** Only variants seen this recently are on the site, so only their groups get a photo. */
const RECENT_DAYS = 7;

/**
 * Hard cap on what we keep in R2 (photo copies and HTML snapshots), below the 10 GB free tier: no photo is
 * downloaded once the stored bytes plus STORAGE_ALLOWANCE_BYTES reach it. Going past it needs the owner's approval.
 */
export const PHOTO_STORAGE_CAP_BYTES = 9e9;
/** Room kept under the cap for one more night of snapshots and the copy being stored. */
const STORAGE_ALLOWANCE_BYTES = 100e6;

export type ImageDeps = {
  sql: postgres.Sql;
  /** one image request (robots, delays and the host allowlist are the fetcher's) */
  fetchImage: (url: string) => Promise<{ status: number; body: Buffer }>;
  /** stores one object in R2 */
  put: (key: string, body: Buffer, contentType: string) => Promise<void>;
  /** the scrape run's own fetcher, so image requests keep the run's gap and Crawl-delay (no request right after the scrape's last) */
  shopFetcher: ShopFetcher;
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
 *
 * opts (the daytime catch-up, src/pipeline/catchUp.ts): perRun replaces the shop's images_per_run and until (epoch
 * ms) replaces its images_minutes deadline. The pace is always the fetcher's: no delay is shortened.
 */
export async function downloadImagesForShop(
  shop: Shop,
  deps: Partial<ImageDeps> = {},
  opts: { perRun?: number; until?: number } = {},
): Promise<{ downloaded: number; linked: number }> {
  // off until IMAGES_ENABLED=on is set for the scrape (to go in scripts/run-local.ps1 and the scrape workflows)
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
  let shopFetcher = deps.shopFetcher;
  const fetchImage =
    deps.fetchImage ??
    (async (url: string) => {
      shopFetcher ??= ShopFetcher.fromConfig(shop.config, userAgent(), shop.base_url, () => {});
      const res = await fetcherFor(url, shop, shopFetcher).get(url, { accept: 'image/avif,image/webp,image/*;q=0.8', maxBodyBytes: MAX_IMAGE_BYTES });
      return { status: res.status, body: res.body };
    });

  const linked = await linkProducts(sql, shop.id);
  const usage = await photoStorage(sql);
  let stored = usage.bytes + usage.snapshotBytes;
  const full = () => stored + STORAGE_ALLOWANCE_BYTES >= PHOTO_STORAGE_CAP_BYTES;
  if (full()) {
    console.error(`[${shop.slug}] images skipped: R2 holds ${(stored / 1e9).toFixed(2)} GB, the cap is ${PHOTO_STORAGE_CAP_BYTES / 1e9} GB`);
    return { downloaded: 0, linked };
  }
  const budget = opts.perRun ?? Number(shop.config.images_per_run ?? 300);
  const deadline = opts.until ?? Date.now() + Number(shop.config.images_minutes ?? 20) * 60_000;
  // more groups than requests: a fetcher that gives up leaves its groups for the next run, and others may follow
  const groups = await photoCandidates(sql, shop.id, budget * 3);
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
      stored += copy.bytes;
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
  // fetchers that gave up in this run (the shop's, or a CDN's after repeated refusals): their URLs wait for the
  // next run unmarked, since the URLs themselves did not fail
  const stopped = new Set<string>();
  run: for (const g of groups) {
    for (const url of new Set(g.urls)) {
      const before = tried.get(url);
      if (before === true) break;
      if (before === false) continue;
      let via: string;
      try {
        via = fetcherName(url, shop);
      } catch {
        via = 'invalid';
      }
      if (stopped.has(via)) continue;
      if (requests >= budget || Date.now() > deadline || full()) break run;
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
        if (e instanceof ShopAbortError || e instanceof OutOfScopeError) {
          // not this URL's failure: no failure mark and no budget spent; the fetcher's other URLs are skipped
          requests--;
          stopped.add(via);
          console.log(`[${shop.slug}] images from ${via === 'shop' ? 'the shop' : via} stopped for this run: ${(e as Error).message}`);
          continue;
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

/**
 * Gives the shop's site rows that have no photo yet the stored copy of one of their variants (the row's own
 * variant first, then the most recently seen), so a photo stored during the day shows on the site before the next
 * site-build, which recomputes every row. Only image_key changes (never updated_at, which decides what is shown).
 */
export async function refreshSiteImageKeys(sql: postgres.Sql, shopId: number): Promise<number> {
  const res = await sql`
    update site_products sp set image_key = x.r2_key
    from (
      select distinct on (s2.id) s2.id, i.r2_key
      from site_products s2
      join products p on p.shop_id = s2.shop_id and coalesce(p.parent_external_id, p.external_id) = s2.group_key
      join images i on i.id = p.image_id and i.r2_key like 'img/%'
      where s2.shop_id = ${shopId} and s2.image_key is null
      order by s2.id, (p.id = s2.rep_product_id) desc, p.last_seen desc, p.id
    ) x
    where sp.id = x.id`;
  return res.count;
}

/**
 * What we keep in R2, for the storage cap and the daily summary: the photo copies (one object per stored key;
 * several image URLs can share one) and the HTML snapshots.
 */
export async function photoStorage(sql: postgres.Sql): Promise<{ count: number; bytes: number; snapshotBytes: number }> {
  const [row] = await sql<{ count: number; bytes: string; snapshot_bytes: string }[]>`
    select count(*)::int as count, coalesce(sum(bytes), 0)::text as bytes,
      (select coalesce(sum(bytes), 0)::text from snapshots where r2_key is not null) as snapshot_bytes
    from (select distinct on (r2_key) r2_key, bytes from images where r2_key like 'img/%') x`;
  return { count: row?.count ?? 0, bytes: Number(row?.bytes ?? 0), snapshotBytes: Number(row?.snapshot_bytes ?? 0) };
}
