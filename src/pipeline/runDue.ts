import { adapterFor } from '../adapters/index.js';
import { db } from '../db.js';
import { ShopAbortError, DisallowedError } from '../http/fetcher.js';
import type { KnownProduct, NormalisedRecord, Shop } from '../types.js';
import { applyIdentifierRules } from '../util/normalise.js';
import { makeContext, recordSchema, type RunResult } from './runShop.js';
import { finishRun, saveBatch, startRun, type FlaggedRow, type RunTotals } from './store.js';
import { updateTiers } from './tiers.js';

interface DueRow extends KnownProduct {
  in_promo: boolean;
  changes_7d: number;
  watch_tier: string;
}

/**
 * Products of one shop whose next_check_at has passed, best first: in an active promotion,
 * then most price changes in the last 7 days, then hot before warm. Normal products are left
 * to the daily full run.
 */
export async function dueProducts(shopId: number, limit: number): Promise<DueRow[]> {
  const rows = await db()<(DueRow & { id: string })[]>`
    select p.id, p.external_id, p.parent_external_id, p.url, p.meta, p.watch_tier,
      exists (
        select 1 from promotion_products pp join promotions pr on pr.id = pp.promotion_id
        where pp.product_id = p.id and pr.status in ('confirmed', 'active')
      ) as in_promo,
      (select count(*)::int from (
         select price_cents, lag(price_cents) over (order by observed_at) as prev
         from price_observations where product_id = p.id and observed_at > now() - interval '7 days' and price_cents > 0
       ) x where x.prev is not null and x.price_cents <> x.prev) as changes_7d
    from products p
    where p.shop_id = ${shopId} and p.watch_tier in ('warm', 'hot')
      and p.next_check_at <= now() and p.last_seen > now() - interval '3 days'
    order by in_promo desc, changes_7d desc, case p.watch_tier when 'hot' then 0 else 1 end, p.next_check_at
    limit ${limit}`;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** How many single-product requests this hourly run may make for a shop. */
export function hourlyBudget(shop: Shop, minutes = 50): number {
  const perHour = Number(shop.config.max_requests_per_hour ?? 600);
  return Math.max(1, Math.floor((perHour * minutes) / 60));
}

export async function runDue(shop: Shop, opts: { dryRun?: boolean; minutes?: number } = {}): Promise<RunResult | null> {
  const budget = hourlyBudget(shop, opts.minutes);
  const due = await dueProducts(shop.id, budget * 4);
  if (!due.length) return null;

  // one request per fetch key: a Shopify product returns all its variants at once
  const groups = new Map<string, DueRow>();
  for (const d of due) {
    const key = shop.adapter === 'shopify' ? (d.parent_external_id ?? d.external_id) : d.external_id;
    if (!groups.has(key)) groups.set(key, d);
  }
  const picks = [...groups.values()].slice(0, budget);

  const t0 = Date.now();
  const errors: string[] = [];
  const perHour = Number(shop.config.max_requests_per_hour ?? 600);
  const minGap = Math.ceil(3_600_000 / perHour);
  const ctx = makeContext(
    { ...shop, config: { ...shop.config, min_delay_ms: Math.max(Number(shop.config.min_delay_ms ?? 2000), minGap) } },
    {},
    errors,
  );
  const runId = opts.dryRun ? null : await startRun(shop.id, 'due');
  const deadline = t0 + (opts.minutes ?? 50) * 60_000;
  const seen = new Set<string>();
  const flagged: FlaggedRow[] = [];
  let aborted: string | null = null;

  try {
    const adapter = adapterFor(shop.adapter);
    for (const p of picks) {
      if (Date.now() > deadline) {
        ctx.log('time budget used up');
        break;
      }
      let recs: NormalisedRecord[] = [];
      try {
        recs = await adapter.fetchOne(ctx, p);
      } catch (e) {
        if (e instanceof ShopAbortError) throw e;
        if (!(e instanceof DisallowedError)) ctx.error(`fetchOne ${p.external_id}: ${(e as Error).message}`);
        continue;
      }
      const clean: NormalisedRecord[] = [];
      for (const raw of recs) {
        if (seen.has(raw.external_id)) continue;
        const parsed = recordSchema.safeParse(applyIdentifierRules(raw, shop.config));
        if (!parsed.success) continue;
        seen.add(raw.external_id);
        // re-reads do not see Shopify collections: keep the Black Friday status from the nightly run
        clean.push({ ...(parsed.data as NormalisedRecord), meta: { ...parsed.data.meta, no_bf: true } });
      }
      if (runId !== null && clean.length) flagged.push(...(await saveBatch(shop, runId, clean, new Date())).flagged);
    }
  } catch (e) {
    aborted = (e as Error).message;
    ctx.log(`run stopped: ${aborted}`);
  }

  const st = ctx.fetcher.stats;
  const totals: RunTotals = {
    status: seen.size === 0 ? 'failed' : aborted || errors.length ? 'partial' : 'ok',
    products_seen: seen.size,
    requests: st.requests,
    failed_requests: st.failed,
    disallowed: st.disallowed,
    errors: errors.length,
    error_log: errors,
    notes: [`due: ${due.length} products, checked ${picks.length} fetch keys (budget ${budget})`, aborted ? `stopped: ${aborted}` : null]
      .filter(Boolean)
      .join('; '),
  };
  if (runId !== null) {
    await finishRun(runId, totals);
    await updateTiers(shop.id, new Date(t0));
  }
  ctx.log(`due run: ${totals.status}, ${seen.size} products re-read, ${st.requests} requests`);
  return { shop, kind: 'due', runId, totals, flagged, sample: [], durationMs: Date.now() - t0 };
}
