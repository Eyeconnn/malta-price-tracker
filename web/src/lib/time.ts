// Malta wall-clock helpers for the headline. Everything is computed in Europe/Malta (not UTC or
// the device zone), so slots stay right across the DST change and for visitors abroad.
import type { PhraseSlot } from '../../../src/site/settings.js';

const TZ = 'Europe/Malta';

/** Black Friday 2026, a Malta calendar date. */
export const BLACK_FRIDAY = '2026-11-27';
/** First day of the `bfweek` slot: the 7 days before Black Friday plus the day itself (Ruling R3). */
export const BF_WEEK_START = '2026-11-20';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

function malta(now: Date): { date: string; hour: number } {
  const parts = partsFmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

/** Malta calendar date of an instant, as YYYY-MM-DD. */
export function maltaDate(now: Date): string {
  return malta(now).date;
}

const dayIndex = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/** Whole Malta calendar days from `now` until Black Friday: 0 on the day, negative after it. */
export function daysToBlackFriday(now: Date): number {
  return dayIndex(BLACK_FRIDAY) - dayIndex(maltaDate(now));
}

/** Headline slot: bfweek on Malta dates 20 to 27 Nov 2026, otherwise by Malta hour. */
export function slotFor(now: Date): PhraseSlot {
  const { date, hour } = malta(now);
  if (date >= BF_WEEK_START && date <= BLACK_FRIDAY) return 'bfweek';
  if (hour < 6) return 'late';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}
