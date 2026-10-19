import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { db } from '../db.js';
import { userAgent } from '../env.js';
import { ShopFetcher, scopeHost } from '../http/fetcher.js';
import { r2Configured, putObject } from '../r2.js';
import type { Shop } from '../types.js';

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

const EXT: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif', svg: 'svg', tiff: 'tif' };
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml', tif: 'image/tiff' };

// CDN hosts (cdn.shopify.com etc.) are shared by many shops: one fetcher per host for the whole process.
const cdnFetchers = new Map<string, ShopFetcher>();

function fetcherFor(url: string, shop: Shop, shopFetcher: ShopFetcher): ShopFetcher {
  const host = new URL(url).hostname;
  const scope = scopeHost(shop.base_url);
  if (host === scope || host.endsWith(`.${scope}`)) return shopFetcher;
  let f = cdnFetchers.get(host);
  if (!f) {
    f = new ShopFetcher({ userAgent: userAgent(), minDelayMs: 300, maxDelayMs: 800, maxBodyBytes: 15 * 1024 * 1024 });
    cdnFetchers.set(host, f);
  }
  return f;
}

/**
 * Downloads images for products that have an image_url but no image_id yet, within a per-run
 * budget (config images_per_run, default 300; config images_minutes, default 20). An image URL is
 * fetched at most once: later products with the same URL are linked to the stored row.
 */
export async function downloadImagesForShop(shop: Shop): Promise<{ downloaded: number; linked: number }> {
  if (!r2Configured()) {
    console.log(`[${shop.slug}] images skipped: R2 is not configured`);
    return { downloaded: 0, linked: 0 };
  }
  const sql = db();
  // link products whose image URL we already have
  const linked = await sql`
    update products p set image_id = i.id from images i
    where p.shop_id = ${shop.id} and p.image_id is null and p.image_url = i.source_url`;

  const budget = Number(shop.config.images_per_run ?? 300);
  const deadline = Date.now() + Number(shop.config.images_minutes ?? 20) * 60_000;
  const todo = await sql<{ image_url: string }[]>`
    select distinct p.image_url from products p
    left join images i on i.source_url = p.image_url
    where p.shop_id = ${shop.id} and p.image_id is null and p.image_url is not null and i.id is null
    limit ${budget}`;
  if (!todo.length) return { downloaded: 0, linked: linked.count };

  const shopFetcher = ShopFetcher.fromConfig(shop.config, userAgent(), shop.base_url, () => {});
  let downloaded = 0;
  for (const { image_url } of todo) {
    if (Date.now() > deadline) break;
    try {
      const f = fetcherFor(image_url, shop, shopFetcher);
      const res = await f.get(image_url, { accept: 'image/avif,image/webp,image/*;q=0.8' });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const buf = res.body;
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const meta = await sharp(buf).metadata();
      const ext = EXT[meta.format ?? ''] ?? 'bin';
      const phash = meta.format === 'svg' ? null : await dHash(buf);
      const [existing] = await sql<{ r2_key: string }[]>`select r2_key from images where sha256 = ${sha256} and r2_key is not null limit 1`;
      const key = existing?.r2_key ?? `images/${sha256}.${ext}`;
      if (!existing) await putObject(key, buf, MIME[ext] ?? 'application/octet-stream');
      await sql`
        insert into images (source_url, r2_key, sha256, phash, width, height, content_type, bytes)
        values (${image_url}, ${key}, ${sha256}, ${phash}, ${meta.width ?? null}, ${meta.height ?? null}, ${MIME[ext] ?? null}, ${buf.length})
        on conflict (source_url) do nothing`;
      downloaded++;
    } catch (e) {
      // remember the failure so the URL is not fetched again every night
      await sql`insert into images (source_url, error) values (${image_url}, ${(e as Error).message.slice(0, 300)})
                on conflict (source_url) do nothing`;
    }
  }
  await sql`
    update products p set image_id = i.id from images i
    where p.shop_id = ${shop.id} and p.image_id is null and p.image_url = i.source_url and i.r2_key is not null`;
  console.log(`[${shop.slug}] images: ${downloaded} downloaded, ${todo.length - downloaded} skipped or failed`);
  return { downloaded, linked: linked.count };
}
