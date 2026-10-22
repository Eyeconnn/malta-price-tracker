// Price history by Malta calendar day for one variant: what the product page's chart and day table show.
import { maltaDay } from '../../../src/site/verdict.js';
import type { HistoryObs } from '@/lib/api';

/** One Malta day of one variant: the last observation of that day. Prices in cents, null when not shown. */
export type DayRow = {
  /** YYYY-MM-DD, Malta time */
  day: string;
  price: number | null;
  was: number | null;
  bf: boolean;
  /** against the previous tracked day; null when either day has no price */
  change: { cents: number; pct: number } | null;
  /**
   * The server's "days worth buying" rule (src/site/verdict.ts): the price was at or below the
   * verdict's lowest 30-day price (facts.low30). null without a price or without low30.
   */
  worth: boolean | null;
};

const DAY_MS = 86_400_000;
const dayIndex = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Percent change rounded to one decimal, as the verdict engine rounds it (no -0). */
function pct(from: number, to: number): number {
  const r = Math.round(((to - from) / from) * 1000) / 10;
  return r === 0 ? 0 : r;
}

/**
 * The days of variant `productId`, oldest first. `low30` is facts.low30 of the verdict; pass null for a
 * variant the verdict is not about, so no day is called worth buying from another variant's facts.
 */
export function dayRows(history: readonly HistoryObs[], productId: number, low30: number | null): DayRow[] {
  const byDay = new Map<string, HistoryObs>();
  const own = history.filter((h) => h.productId === productId).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const h of own) {
    const t = new Date(h.at);
    if (Number.isNaN(t.getTime())) continue;
    byDay.set(maltaDay(t), h);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const rows: DayRow[] = [];
  for (const [day, h] of days) {
    const price = positive(h.price) ? h.price : null;
    const prev = rows.at(-1)?.price ?? null;
    rows.push({
      day,
      price,
      was: positive(h.was) ? h.was : null,
      bf: h.bf === true,
      change: price !== null && prev !== null ? { cents: price - prev, pct: pct(prev, price) } : null,
      worth: price !== null && positive(low30) ? price <= low30 : null,
    });
  }
  return rows;
}

/** The rows within the last `n` Malta days of the latest row (the latest day counts as one). */
export function lastDays(rows: readonly DayRow[], n: number): DayRow[] {
  const latest = rows.at(-1);
  if (!latest) return [];
  const from = dayIndex(latest.day) - n;
  return rows.filter((r) => dayIndex(r.day) > from);
}

/** Days since the epoch of a row, for a numeric chart axis. */
export const rowIndex = (r: DayRow) => dayIndex(r.day);

/**
 * The latest day whose price differs from the day before, when it is within the last `withinDays`
 * days of the history; null otherwise.
 */
export function recentChange(rows: readonly DayRow[], withinDays: number): { row: DayRow; from: number } | null {
  const latest = rows.at(-1);
  if (!latest) return null;
  for (let i = rows.length - 1; i > 0; i--) {
    const r = rows[i]!;
    if (dayIndex(latest.day) - dayIndex(r.day) >= withinDays) return null;
    if (r.change && r.change.cents !== 0) return { row: r, from: r.price! - r.change.cents };
  }
  return null;
}
