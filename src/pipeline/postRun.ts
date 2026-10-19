import type { RunResult } from './runShop.js';
import { updateTiers } from './tiers.js';
import { checkRun } from './alerts.js';
import { closeStaleRuns } from './store.js';
import { downloadImagesForShop } from './images.js';
import { sendEmail } from '../email.js';

/** Per-shop work after its prices are stored: tiers and next_check_at, then images. */
export async function afterRun(r: RunResult, opts: { images: boolean }): Promise<void> {
  if (r.runId === null || r.totals.products_seen === 0) return;
  const since = new Date(Date.now() - r.durationMs - 60_000);
  try {
    await updateTiers(r.shop.id, since);
  } catch (e) {
    console.error(`[${r.shop.slug}] tier update failed: ${(e as Error).message}`);
  }
  if (opts.images) {
    try {
      await downloadImagesForShop(r.shop);
    } catch (e) {
      console.error(`[${r.shop.slug}] images failed: ${(e as Error).message}`);
    }
  }
}

/** After every shop in this invocation has finished: one alert email listing every problem. */
export async function afterAllRuns(results: RunResult[], opts: { alerts: boolean }): Promise<void> {
  const sections: string[] = [];
  for (const r of results) {
    const problems = await checkRun(r);
    if (problems.length) sections.push(`${r.shop.name} (${r.shop.slug}), run ${r.runId}, ${r.totals.status}:\n  - ${problems.join('\n  - ')}`);
  }
  const stale = await closeStaleRuns();
  for (const s of stale) sections.push(`${s.slug}: run ${s.id} started ${s.started_at.toISOString()} never finished (marked failed)`);
  if (!sections.length) return;
  const subject = `[price tracker] ${sections.length} problem${sections.length > 1 ? 's' : ''}: ${results.map((r) => r.shop.slug).slice(0, 6).join(', ')}`;
  const body = `${sections.join('\n\n')}\n\nFlagged rows are kept with review_flag set; do not trust them until checked.`;
  if (opts.alerts) await sendEmail(subject, body);
  else console.log(body);
}
