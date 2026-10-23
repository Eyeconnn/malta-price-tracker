import { z } from 'zod';
import { adapterFor } from '../adapters/index.js';
import { ShopAbortError, ShopFetcher } from '../http/fetcher.js';
import { userAgent } from '../env.js';
import type { CrawlContext, NormalisedRecord, Shop } from '../types.js';
import { applyIdentifierRules } from '../util/normalise.js';
import { finishRun, idsNeedingDetail, saveBatch, startRun, type FlaggedRow, type RunTotals } from './store.js';

const cents = z.number().int().nullable();
export const recordSchema = z.object({
  external_id: z.string().min(1),
  parent_external_id: z.string().nullable().optional(),
  url: z.string().nullable(),
  sku: z.string().nullable(),
  gtin: z.string().nullable(),
  mpn: z.string().nullable(),
  brand: z.string().nullable(),
  title: z.string().nullable(),
  variant_title: z.string().nullable(),
  category_path: z.string().nullable(),
  tags: z.array(z.string()),
  image_url: z.string().nullable(),
  shop_created_at: z.string().nullable(),
  price_cents: cents,
  was_price_cents: cents,
  shop_30d_low_cents: cents,
  in_stock: z.boolean().nullable(),
  on_sale: z.boolean().nullable(),
  badge_text: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export interface RunResult {
  shop: Shop;
  kind?: 'full' | 'due';
  runId: number | null;
  totals: RunTotals;
  flagged: FlaggedRow[];
  sample: NormalisedRecord[];
  durationMs: number;
  /** requests that finally failed with 429 or 5xx, and the last Retry-After (ms) seen on them */
  rateLimited?: { count: number; retryAfterMs: number | null };
}

export interface RunOptions {
  dryRun?: boolean;
  limit?: number;
  /** keep this many records in memory for display (dry runs) */
  sampleSize?: number;
  /** hard request cap for this run only (the shop-request test scrape); past it the run stops */
  maxRequests?: number;
  log?: (msg: string) => void;
}

export function makeContext(shop: Shop, opts: { limit?: number; maxRequests?: number; log?: (m: string) => void }, errors: string[]): CrawlContext {
  const log = opts.log ?? ((m: string) => console.log(`[${shop.slug}] ${m}`));
  const fetcher = ShopFetcher.fromConfig(shop.config, userAgent(), shop.base_url, log, { maxRequests: opts.maxRequests });
  return {
    shop,
    fetcher,
    limit: opts.limit,
    log,
    error: (m: string) => {
      errors.push(m);
      log(`error: ${m}`);
    },
  };
}

/** One full catalogue run for one shop: crawl, validate, store, close the scrape_runs row. */
export async function runShop(shop: Shop, opts: RunOptions = {}): Promise<RunResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  const ctx = makeContext(shop, opts, errors);
  const runId = opts.dryRun ? null : await startRun(shop.id, 'full');
  if (runId !== null) ctx.needsDetail = (ids) => idsNeedingDetail(shop.id, ids);
  const seen = new Set<string>();
  const flagged: FlaggedRow[] = [];
  const sample: NormalisedRecord[] = [];
  let aborted: string | null = null;

  try {
    const adapter = adapterFor(shop.adapter);
    const robots = await ctx.fetcher.robotsFor(shop.base_url);
    if (robots.status === 'unreachable') throw new ShopAbortError('robots.txt unreachable (server errors): not crawling');

    for await (const batch of adapter.crawl(ctx)) {
      const clean: NormalisedRecord[] = [];
      for (const raw of batch) {
        if (seen.has(raw.external_id)) continue; // catalogue shifted between pages
        const parsed = recordSchema.safeParse(applyIdentifierRules(raw, shop.config));
        if (!parsed.success) {
          ctx.error(`invalid record ${raw.external_id}: ${parsed.error.issues[0]?.message}`);
          continue;
        }
        seen.add(raw.external_id);
        clean.push(parsed.data as NormalisedRecord);
        if (opts.limit && seen.size >= opts.limit) break;
      }
      if (sample.length < (opts.sampleSize ?? 0)) sample.push(...clean.slice(0, (opts.sampleSize ?? 0) - sample.length));
      if (runId !== null && clean.length) {
        const res = await saveBatch(shop, runId, clean, new Date());
        flagged.push(...res.flagged);
      }
      if (opts.limit && seen.size >= opts.limit) break;
    }
  } catch (e) {
    aborted = (e as Error).message;
    ctx.log(`run stopped: ${aborted}`);
    if (!(e instanceof ShopAbortError)) errors.push(aborted);
  }

  const st = ctx.fetcher.stats;
  const failRatio = st.requests ? st.failed / st.requests : 0;
  let status: RunTotals['status'] = 'ok';
  if (seen.size === 0) status = 'failed';
  else if (aborted || errors.length || failRatio > 0.05) status = 'partial';

  const notes = [
    aborted ? `stopped: ${aborted}` : null,
    st.disallowed ? `${st.disallowed} URLs skipped by robots.txt (e.g. ${ctx.fetcher.disallowedUrls.slice(0, 3).join(', ')})` : null,
    st.retries ? `${st.retries} retries` : null,
  ]
    .filter(Boolean)
    .join('; ');

  const totals: RunTotals = {
    status,
    products_seen: seen.size,
    requests: st.requests,
    failed_requests: st.failed,
    disallowed: st.disallowed,
    errors: errors.length,
    error_log: errors,
    notes: notes || null,
  };
  if (runId !== null) await finishRun(runId, totals);
  ctx.log(
    `done: ${status}, ${seen.size} products, ${st.requests} requests (${st.failed} failed), ${errors.length} errors, ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  return { shop, runId, totals, flagged, sample, durationMs: Date.now() - t0, rateLimited: { count: st.rateLimited, retryAfterMs: st.retryAfterMs } };
}
