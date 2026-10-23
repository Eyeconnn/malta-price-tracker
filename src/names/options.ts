// Option checks of pnpm normalise-names that do not need the database.
import { EFFORT_LEVELS, type Effort } from './claude.js';

/** A run that writes to the database must be bounded: --pilot (sample) or --max-batches (cap). */
export function checkRunScope(o: { dryRun: boolean; pilot: boolean; maxBatches: number | undefined }): void {
  if (!o.dryRun && !o.pilot && o.maxBatches === undefined) {
    throw new Error('a run that writes to the database needs --pilot or --max-batches (or use --dry-run)');
  }
}

/** --effort: one of the CLI levels; undefined leaves the CLI default. */
export function parseEffort(raw: string | undefined): Effort | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (!(EFFORT_LEVELS as readonly string[]).includes(v)) throw new Error(`--effort must be one of ${EFFORT_LEVELS.join(', ')}, got ${v}`);
  return v as Effort;
}

/** --max-cost: a positive number of dollars (the cost Claude Code reports), undefined for no cap. */
export function parseMaxCost(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  const n = /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--max-cost needs a positive number of dollars, got ${raw}`);
  return n;
}

/** Whether the summed reported cost has reached the --max-cost cap: then no new batch starts (running ones finish). */
export function budgetReached(spentUsd: number, maxCostUsd: number | undefined): boolean {
  return maxCostUsd !== undefined && spentUsd >= maxCostUsd;
}
