import type { RunResult } from './runShop.js';

/** Per-shop work after its prices are stored: tiers and next_check_at, then images. */
export async function afterRun(_r: RunResult, _opts: { images: boolean }): Promise<void> {}

/** After every shop in this invocation has finished: alerts. */
export async function afterAllRuns(_results: RunResult[], _opts: { alerts: boolean }): Promise<void> {}
