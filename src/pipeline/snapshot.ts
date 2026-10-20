import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { userAgent } from '../env.js';
import { ShopFetcher } from '../http/fetcher.js';
import { putObject, r2Configured, r2Writable } from '../r2.js';
import type { Shop } from '../types.js';

/**
 * Saves the full HTML of a URL to R2 (snapshots/{host}/{yyyy-mm-dd}/{iso time}-{sha256 prefix}.html)
 * and records it in the snapshots table. Used for Black Friday landing pages (scheduled later).
 */
export async function snapshotUrl(url: string, shop?: Shop, dryRun = false) {
  const fetcher = shop
    ? ShopFetcher.fromConfig(shop.config, userAgent(), shop.base_url, (m) => console.log(`[snapshot] ${m}`))
    : new ShopFetcher({ userAgent: userAgent(), log: (m) => console.log(`[snapshot] ${m}`) });
  const res = await fetcher.get(url, { accept: 'text/html,application/xhtml+xml' });
  const sha256 = createHash('sha256').update(res.body).digest('hex');
  const now = new Date();
  const key = `snapshots/${new URL(url).hostname}/${now.toISOString().slice(0, 10)}/${now.toISOString().replace(/[:.]/g, '-')}-${sha256.slice(0, 12)}.html`;
  if (dryRun || !r2Configured() || !(await r2Writable())) {
    console.log(`snapshot of ${url}: HTTP ${res.status}, ${res.body.length} bytes, sha256 ${sha256} (not stored${dryRun ? ': dry run' : ': R2 not configured or not writable'})`);
    return { key: null, sha256, status: res.status, bytes: res.body.length };
  }
  await putObject(key, res.body, 'text/html; charset=utf-8');
  await db()`insert into snapshots (shop_id, url, captured_at, http_status, r2_key, sha256, bytes)
             values (${shop?.id ?? null}, ${url}, ${now}, ${res.status}, ${key}, ${sha256}, ${res.body.length})`;
  console.log(`snapshot of ${url} stored at ${key}`);
  return { key, sha256, status: res.status, bytes: res.body.length };
}
