import { db } from '../db.js';
import type { RunResult } from './runShop.js';

const euro = (c: number | null) => (c === null ? 'none' : `EUR ${(c / 100).toFixed(2)}`);

/** Problems with one finished run, as human-readable lines (empty when all is well). */
export async function checkRun(r: RunResult): Promise<string[]> {
  const out: string[] = [];
  const t = r.totals;
  if (t.status === 'failed') out.push(`run failed: ${t.notes ?? t.error_log[0] ?? 'no products seen'}`);
  else if (t.notes?.startsWith('stopped:')) out.push(`run did not finish: ${t.notes}`);

  if (r.runId !== null && r.kind !== 'due') {
    const [avg] = await db()<{ avg: number | null; n: number }[]>`
      select avg(products_seen)::float as avg, count(*)::int as n from scrape_runs
      where shop_id = ${r.shop.id} and kind = 'full' and status in ('ok', 'partial') and id <> ${r.runId}
        and started_at > now() - interval '7 days'`;
    if (avg?.avg && avg.n > 0 && t.products_seen < avg.avg * 0.7) {
      out.push(`products seen dropped to ${t.products_seen}, more than 30% below the 7-day average of ${Math.round(avg.avg)}`);
    }
  }
  if (t.requests > 0 && t.failed_requests / t.requests > 0.05) {
    out.push(`${t.failed_requests} of ${t.requests} fetches failed (${((100 * t.failed_requests) / t.requests).toFixed(1)}%)`);
  }
  if (r.flagged.length) {
    const byFlag = new Map<string, number>();
    for (const f of r.flagged) byFlag.set(f.flag, (byFlag.get(f.flag) ?? 0) + 1);
    out.push(
      `${r.flagged.length} price rows flagged for review (${[...byFlag].map(([k, v]) => `${k}: ${v}`).join(', ')}). Examples:\n` +
        r.flagged
          .slice(0, 10)
          .map((f) => `    - ${f.flag}: ${f.title ?? f.external_id} now ${euro(f.price_cents)}, before ${euro(f.prev_price_cents)} ${f.url ?? ''}`)
          .join('\n'),
    );
  }
  if (t.error_log.length && t.status !== 'failed') out.push(`${t.errors} errors, first: ${t.error_log[0]}`);
  return out;
}
