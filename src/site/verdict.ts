// Verdict engine: decides from one product variant's price history whether its deal is real
// (spec 6.7 and 9a). Prices are integer cents. Verdicts name real shops publicly, so every
// reason sentence states only facts taken from the history.
import type { Thresholds } from './settings.js';

export type Obs = { at: Date; price: number | null; was: number | null; inStock: boolean | null; bf: boolean | null };

export type VerdictFacts = {
  /** lowest positive price over up to baselineDays of history before the current price started */
  low30: number | null;
  /** median price over the same days */
  usual: number | null;
  claimedPct: number | null;
  realPct: number | null;
  raisedFrom?: { price: number; at: string };
  raisedTo?: { price: number; at: string };
  wasRaisedFrom?: number;
  historyDays: number;
  priceChanges: number;
  wasChanges: number;
  daysWorthBuying: number;
};

export type Verdict = { label: 'good' | 'avoid' | 'none' | 'insufficient'; reason: string; facts: VerdictFacts };

const TZ = 'Europe/Malta';
const DAY_MS = 86_400_000;

const dayKeyFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
// en-US parts give "Sep" (en-GB gives "Sept"); the parts are reassembled as "22 Oct".
const dayLabelFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, day: 'numeric', month: 'short' });
const euroFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Malta calendar day of an instant, as YYYY-MM-DD. */
export function maltaDay(d: Date): string {
  const parts = dayKeyFmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "22 Oct" for a YYYY-MM-DD Malta day. */
export function formatDay(day: string): string {
  // Noon UTC on that date is the same calendar day in Malta.
  const parts = dayLabelFmt.formatToParts(new Date(`${day}T12:00:00Z`));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')} ${get('month')}`;
}

/** "€1,234.56" for 123456 cents. */
export function formatEuro(cents: number): string {
  return `€${euroFmt.format(cents / 100)}`;
}

type Day = { day: string; idx: number; price: number | null; was: number | null; bf: boolean };

/** Days since the epoch for a YYYY-MM-DD day, for calendar-day arithmetic. */
function dayIndex(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

/** One entry per Malta day: the last observation of that day. Sorted oldest first. */
function collapseToDays(obs: Obs[]): Day[] {
  const sorted = [...obs].sort((a, b) => a.at.getTime() - b.at.getTime());
  const byDay = new Map<string, Obs>();
  for (const o of sorted) byDay.set(maltaDay(o.at), o);
  return [...byDay.entries()]
    .map(([day, o]) => ({ day, idx: dayIndex(day), price: o.price, was: o.was, bf: o.bf === true }))
    .sort((a, b) => a.idx - b.idx);
}

const positive = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;

function pct(from: number, to: number): number {
  const r = Math.round(((to - from) / from) * 1000) / 10;
  return r === 0 ? 0 : r; // no -0
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** More than `limitPct` percent above `from`, compared in integers so 3.0% is not "more than 3". */
function roseMoreThan(from: number, to: number, limitPct: number): boolean {
  return (to - from) * 100 > limitPct * from;
}

type Change = { from: Day; to: Day; fromValue: number; toValue: number };

/** Day-to-day changes of one series, skipping days where it is missing. */
function changes(days: Day[], value: (d: Day) => number | null): Change[] {
  const out: Change[] = [];
  let prev: Day | null = null;
  for (const d of days) {
    const v = value(d);
    if (!positive(v)) continue;
    if (prev) {
      const pv = value(prev) as number;
      if (pv !== v) out.push({ from: prev, to: d, fromValue: pv, toValue: v });
    }
    prev = d;
  }
  return out;
}

export function computeVerdict(obs: Obs[], t: Thresholds, now: Date): Verdict {
  const days = collapseToDays(obs);
  const latest = days.at(-1);
  const priced = days.filter((d) => positive(d.price));
  const priceChanges = changes(days, (d) => d.price);
  const wasChanges = changes(days, (d) => d.was);

  // Baseline: up to baselineDays of history before the day the current price started.
  // If the price never changed, there is nothing before it, so the current run itself is used.
  let low30: number | null = null;
  let usual: number | null = null;
  let runStart: Day | undefined;
  let baselineFirst: Day | undefined;
  const lastPriced = priced.at(-1);
  if (lastPriced) {
    runStart = priceChanges.at(-1)?.to ?? priced[0];
    const start = runStart;
    let window = priced.filter((d) => d.idx < start.idx && d.idx >= start.idx - t.baselineDays);
    if (window.length === 0) window = priced.filter((d) => d.idx >= start.idx && d.idx > lastPriced.idx - t.baselineDays);
    else baselineFirst = window[0];
    const prices = window.map((d) => d.price as number);
    low30 = Math.min(...prices);
    usual = median(prices);
  }

  const latestPrice = latest && positive(latest.price) ? latest.price : null;
  const latestWas = latest && positive(latest.was) ? latest.was : null;
  const claimedPct = latestPrice !== null && latestWas !== null && latestWas > latestPrice ? pct(latestWas, latestPrice) : null;
  const realPct = latestPrice !== null && low30 !== null ? pct(low30, latestPrice) : null;

  const facts: VerdictFacts = {
    low30,
    usual,
    claimedPct,
    realPct,
    historyDays: days.length,
    priceChanges: priceChanges.length,
    wasChanges: wasChanges.length,
    daysWorthBuying: low30 === null ? 0 : priced.filter((d) => (d.price as number) <= low30).length,
  };

  if (!latest || latestPrice === null) {
    return { label: 'insufficient', reason: 'Price not shown by the shop.', facts };
  }
  if (days.length < t.minHistoryDays) {
    return {
      label: 'insufficient',
      reason: `Not enough history yet: ${days.length} ${days.length === 1 ? 'day' : 'days'} tracked, ${t.minHistoryDays} needed.`,
      facts,
    };
  }

  const judged = latest.bf || claimedPct !== null;
  if (!judged) return { label: 'none', reason: 'Not marked Black Friday and no discount claimed.', facts };

  // Rises of more than raisePct whose higher value first appeared within the last raiseWindowDays.
  const today = dayIndex(maltaDay(now));
  const inWindow = (c: Change) => today - c.to.idx < t.raiseWindowDays && roseMoreThan(c.fromValue, c.toValue, t.raisePct);
  const priceRise = priceChanges.filter(inWindow).at(-1);
  const wasRise = wasChanges.filter(inWindow).at(-1);

  if (priceRise) {
    facts.raisedFrom = { price: priceRise.fromValue, at: priceRise.from.day };
    facts.raisedTo = { price: priceRise.toValue, at: priceRise.to.day };
  }
  if (wasRise) facts.wasRaisedFrom = wasRise.fromValue;

  if (priceRise) {
    const to = priceRise.to;
    let context: string;
    if (to.bf) context = ' while marked Black Friday';
    else if (positive(to.was) && to.was > priceRise.toValue) context = ` while showing a was price of ${formatEuro(to.was)}`;
    else if (latest.bf) context = ', and it is now marked Black Friday';
    else context = `, and it now shows a was price of ${formatEuro(latestWas as number)}`;
    return {
      label: 'avoid',
      reason: `Price went from ${formatEuro(priceRise.fromValue)} on ${formatDay(priceRise.from.day)} to ${formatEuro(priceRise.toValue)} on ${formatDay(to.day)}${context}.`,
      facts,
    };
  }
  if (wasRise) {
    const to = wasRise.to;
    let context = '';
    if (to.bf) context = ' while marked Black Friday';
    else if (positive(to.price) && to.price === wasRise.from.price) context = ` while the price stayed at ${formatEuro(to.price)}`;
    return {
      label: 'avoid',
      reason: `Was price went from ${formatEuro(wasRise.fromValue)} on ${formatDay(wasRise.from.day)} to ${formatEuro(wasRise.toValue)} on ${formatDay(to.day)}${context}.`,
      facts,
    };
  }

  const start = runStart as Day;
  if (!baselineFirst || low30 === null) {
    return { label: 'none', reason: `Price has been ${formatEuro(latestPrice)} on every day we tracked since ${formatDay(start.day)}.`, facts };
  }

  const span = `in the ${start.idx - baselineFirst.idx} days before ${formatDay(start.day)} (${formatEuro(low30)})`;
  if ((low30 - latestPrice) * 100 >= t.goodDropPct * low30) {
    return { label: 'good', reason: `${formatEuro(low30 - latestPrice)} below its lowest price ${span}.`, facts };
  }
  const rel =
    latestPrice === low30
      ? 'equals its lowest price'
      : `is ${Math.abs(realPct as number).toFixed(1)}% ${latestPrice < low30 ? 'below' : 'above'} its lowest price`;
  return { label: 'none', reason: `Price ${formatEuro(latestPrice)} ${rel} ${span}.`, facts };
}
