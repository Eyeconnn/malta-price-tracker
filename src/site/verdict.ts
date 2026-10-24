// Verdict engine: decides from one product variant's price history whether its deal is real
// (spec 6.7 and 9a). Prices are integer cents. Verdicts name real shops publicly, so every
// reason sentence states only facts taken from the history.
import type { Thresholds } from './settings.js';

export type Obs = { at: Date; price: number | null; was: number | null; inStock: boolean | null; bf: boolean | null };

export type VerdictFacts = {
  /**
   * lowest positive price over up to baselineDays of history before the current price and was price started,
   * from every reading of those days (not only the last of each day)
   */
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
  /** days whose (last) price was at or below low30, as the product page's day table shows them */
  daysWorthBuying: number;
  /**
   * judged (spec 6.7, 9a): enough history, a shown price, and marked Black Friday or showing a was price above
   * the price. Every good and avoid is judged; a none may be. Shop ratings count judged products.
   */
  judged: boolean;
};

export type Verdict = { label: 'good' | 'avoid' | 'none' | 'insufficient'; reason: string; facts: VerdictFacts };

/** What the shop's reference price is called when the shop has no term of its own (config.shown_was.was_label). */
export const DEFAULT_WAS_LABEL = 'Was price';

export type VerdictOptions = {
  /** the shop's own term for its reference price, e.g. "List price"; null or absent: "Was price" */
  wasLabel?: string | null;
};

/**
 * The reference price's name inside a sentence and at its start: "List Price" gives "list price" and "List price".
 * Capitalised words are lower-cased, acronyms ("RRP") keep their capitals.
 */
export function wasTerms(label: string | null | undefined): { start: string; inner: string } {
  const t = (label?.trim() || DEFAULT_WAS_LABEL).replace(/\s+/g, ' ');
  const inner = t
    .split(' ')
    .map((w) => (/^[A-Z][a-z]/.test(w) ? w.charAt(0).toLowerCase() + w.slice(1) : w))
    .join(' ');
  return { start: inner.charAt(0).toUpperCase() + inner.slice(1), inner };
}

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

/** One Malta day: the values of its last observation, and every positive price seen that day. */
type Day = { day: string; idx: number; price: number | null; was: number | null; bf: boolean; readings: number[] };

/** Days since the epoch for a YYYY-MM-DD day, for calendar-day arithmetic. */
function dayIndex(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

const positive = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;

/** One entry per Malta day: the last observation of that day, plus all of its positive prices. Sorted oldest first. */
function collapseToDays(obs: Obs[]): Day[] {
  const sorted = [...obs].sort((a, b) => a.at.getTime() - b.at.getTime());
  const byDay = new Map<string, { last: Obs; readings: number[] }>();
  for (const o of sorted) {
    const key = maltaDay(o.at);
    const entry = byDay.get(key) ?? { last: o, readings: [] };
    entry.last = o;
    if (positive(o.price)) entry.readings.push(o.price);
    byDay.set(key, entry);
  }
  return [...byDay.entries()]
    .map(([day, { last: o, readings }]) => ({ day, idx: dayIndex(day), price: o.price, was: o.was, bf: o.bf === true, readings }))
    .sort((a, b) => a.idx - b.idx);
}

const dayCount = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

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

/** Day-to-day value changes of one series, skipping days where it is missing. */
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

/**
 * Last priced day on which the was price changed, counting a was price appearing or
 * disappearing. Days with a hidden price are skipped, so a hidden day is not a was change.
 */
function lastWasChange(priced: Day[]): Day | undefined {
  const wasOf = (d: Day) => (positive(d.was) ? d.was : null);
  let last: Day | undefined;
  for (let i = 1; i < priced.length; i++) if (wasOf(priced[i]) !== wasOf(priced[i - 1])) last = priced[i];
  return last;
}

type Rise = { base: number; from: Day; to: Day; toValue: number };

/**
 * Net rise of one series. base = its last value on or before day `cutoff` (or its first value
 * when its history starts after `cutoff`). It is a rise when the latest value is more than
 * raisePct above base. `to` is the first day after the base day with the latest value;
 * `from` is the last day base was seen before `to`.
 */
function netRise(
  days: Day[],
  value: (d: Day) => number | null,
  cutoff: number,
  latestValue: number | null,
  raisePct: number,
): Rise | null {
  if (latestValue === null) return null;
  const valued = days.filter((d) => positive(value(d)));
  const baseDay = valued.filter((d) => d.idx <= cutoff).at(-1) ?? valued[0];
  if (!baseDay) return null;
  const base = value(baseDay) as number;
  if (!roseMoreThan(base, latestValue, raisePct)) return null;
  const to = valued.find((d) => d.idx > baseDay.idx && value(d) === latestValue);
  if (!to) return null;
  const from = valued.filter((d) => d.idx >= baseDay.idx && d.idx < to.idx && value(d) === base).at(-1) as Day;
  return { base, from, to, toValue: latestValue };
}

/** True when every positive reading on the days from day index `from` to `to` (inclusive) was `price`. */
function steadyPrice(days: Day[], from: number, to: number, price: number): boolean {
  return days.filter((d) => d.idx >= from && d.idx <= to).every((d) => d.readings.every((p) => p === price));
}

function wasRiseText(r: Rise, was: string): string {
  return `${was} went from ${formatEuro(r.base)} on ${formatDay(r.from.day)} to ${formatEuro(r.toValue)} on ${formatDay(r.to.day)}`;
}

export function computeVerdict(obs: Obs[], t: Thresholds, now: Date, opts: VerdictOptions = {}): Verdict {
  const was = wasTerms(opts.wasLabel);
  const days = collapseToDays(obs);
  const latest = days.at(-1);
  const priced = days.filter((d) => positive(d.price));
  const priceChanges = changes(days, (d) => d.price);
  const wasChanges = changes(days, (d) => d.was);

  // Baseline: up to baselineDays of history before the day the current price and was price
  // started (the later of the last price change and the last was change). If nothing came
  // before that day, the current run itself is used.
  let low30: number | null = null;
  let usual: number | null = null;
  let runStart: Day | undefined;
  let baselineFirst: Day | undefined;
  const lastPriced = priced.at(-1);
  if (lastPriced) {
    const anchors = [priceChanges.at(-1)?.to, lastWasChange(priced)].filter((d): d is Day => d !== undefined);
    runStart = anchors.sort((a, b) => b.idx - a.idx)[0] ?? priced[0];
    const start = runStart;
    let window = priced.filter((d) => d.idx < start.idx && d.idx >= start.idx - t.baselineDays);
    if (window.length === 0) window = priced.filter((d) => d.idx >= start.idx && d.idx > lastPriced.idx - t.baselineDays);
    else baselineFirst = window[0];
    // every reading of the baseline days counts for the low (a price charged in the morning is still charged)
    low30 = Math.min(...window.flatMap((d) => d.readings));
    usual = median(window.map((d) => d.price as number));
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
    judged: false,
  };

  if (!latest || latestPrice === null) {
    return { label: 'insufficient', reason: 'Price not shown by the shop.', facts };
  }
  if (days.length < t.minHistoryDays) {
    return {
      label: 'insufficient',
      reason: `Not enough history yet: ${dayCount(days.length)} tracked, ${t.minHistoryDays} needed.`,
      facts,
    };
  }

  const judged = latest.bf || claimedPct !== null;
  if (!judged) return { label: 'none', reason: 'Not marked Black Friday and no discount claimed.', facts };
  facts.judged = true;

  // Net rises: the latest value against the last value on or before the start of the raise window.
  const today = dayIndex(maltaDay(now));
  const priceRise = netRise(days, (d) => d.price, today - t.raiseWindowDays, latestPrice, t.raisePct);
  const wasRise = netRise(days, (d) => d.was, today - t.raiseWindowDays, latestWas, t.raisePct);

  if (priceRise) {
    facts.raisedFrom = { price: priceRise.base, at: priceRise.from.day };
    facts.raisedTo = { price: priceRise.toValue, at: priceRise.to.day };
  }
  if (wasRise) facts.wasRaisedFrom = wasRise.base;

  if (priceRise) {
    const to = priceRise.to;
    let context: string;
    if (to.bf) context = ' while marked Black Friday';
    else if (positive(to.was) && to.was > priceRise.toValue) context = ` while showing a ${was.inner} of ${formatEuro(to.was)}`;
    else if (latest.bf) context = ', and it is now marked Black Friday';
    else context = `, and it now shows a ${was.inner} of ${formatEuro(latestWas as number)}`;
    return {
      label: 'avoid',
      reason: `Price went from ${formatEuro(priceRise.base)} on ${formatDay(priceRise.from.day)} to ${formatEuro(priceRise.toValue)} on ${formatDay(to.day)}${context}.`,
      facts,
    };
  }
  if (wasRise) {
    const to = wasRise.to;
    let context = '';
    if (to.bf) context = ' while marked Black Friday';
    else if (positive(to.price) && to.price === wasRise.from.price && steadyPrice(days, wasRise.from.idx + 1, to.idx, to.price)) {
      context = ` while the price stayed at ${formatEuro(to.price)}`;
    }
    const text = wasRiseText(wasRise, was.inner);
    return { label: 'avoid', reason: `${text.charAt(0).toUpperCase()}${text.slice(1)}${context}.`, facts };
  }

  // Was price above every price actually charged in the last baselineDays days (spec 6.7).
  // Every observation counts here, not only the last of each day, so a price the shop did
  // charge during the day is never ignored.
  if (latestWas !== null) {
    const charged = obs
      .filter((o) => positive(o.price))
      .map((o) => ({ idx: dayIndex(maltaDay(o.at)), price: o.price as number }))
      .filter((o) => o.idx > latest.idx - t.baselineDays && o.idx <= latest.idx);
    const highest = Math.max(...charged.map((o) => o.price)); // charged includes the latest day
    if (latestWas > highest) {
      const sinceIdx = Math.min(...charged.map((o) => o.idx));
      const since = days.find((d) => d.idx === sinceIdx) as Day;
      return {
        label: 'avoid',
        reason: `${was.start} ${formatEuro(latestWas)} is higher than any price charged since ${formatDay(since.day)} (highest ${formatEuro(highest)}).`,
        facts,
      };
    }
  }

  const start = runStart as Day;
  if (!baselineFirst || low30 === null) {
    const reason = steadyPrice(days, start.idx, latest.idx, latestPrice)
      ? `Price has been ${formatEuro(latestPrice)} on every day it showed a price since ${formatDay(start.day)}.`
      : `Price is ${formatEuro(latestPrice)}. Not enough earlier prices to compare it with.`;
    return { label: 'none', reason, facts };
  }

  const span = `in the ${dayCount(start.idx - baselineFirst.idx)} before ${formatDay(start.day)} (${formatEuro(low30)})`;
  const rel =
    latestPrice === low30
      ? 'equals its lowest price'
      : `is ${Math.abs(realPct as number).toFixed(1)}% ${latestPrice < low30 ? 'below' : 'above'} its lowest price`;
  if ((low30 - latestPrice) * 100 >= t.goodDropPct * low30) {
    // Good also needs a was price not raised within the previous baselineDays days (spec 6.7).
    const wasRise30 = netRise(days, (d) => d.was, today - t.baselineDays, latestWas, t.raisePct);
    if (wasRise30) {
      return { label: 'none', reason: `Price ${formatEuro(latestPrice)} ${rel} ${span}, but the ${wasRiseText(wasRise30, was.inner)}.`, facts };
    }
    return { label: 'good', reason: `${formatEuro(low30 - latestPrice)} below its lowest price ${span}.`, facts };
  }
  return { label: 'none', reason: `Price ${formatEuro(latestPrice)} ${rel} ${span}.`, facts };
}
