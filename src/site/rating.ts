// Shop rating: the share of a shop's judged products that were Deals to Avoid, plus half the share whose was
// price was raised. The sentence under the letter states those counts, nothing more (Ruling R54).
import type { Thresholds } from './settings.js';
import { wasTerms } from './verdict.js';

export type Grade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

// A band applies while the score is strictly under `below`; at or above the last edge the grade is F.
const BANDS: { below: number; grade: Grade }[] = [
  { below: 0.05, grade: 'A' },
  { below: 0.1, grade: 'B' },
  { below: 0.2, grade: 'C' },
  { below: 0.3, grade: 'D' },
  { below: 0.45, grade: 'E' },
];

/**
 * SQL condition: a site_products row (alias sp) counts as judged (spec 7.1, 9a; Ruling R53): every good and avoid,
 * and a none whose verdict facts say judged (marked Black Friday or showing a was price above the price, with
 * enough history). Shop ratings and the shop page's stats use this one definition.
 */
export const JUDGED_SQL = `(sp.verdict in ('good', 'avoid') or (sp.verdict = 'none' and sp.facts ->> 'judged' = 'true'))`;

export const NOT_RATED_SENTENCE = 'Not rated yet: not enough Black Friday deals checked.';

const count = new Intl.NumberFormat('en-US');

/**
 * "23 of 120 judged products were Deals to Avoid (9 with a raised was price)." with singulars where they belong.
 * wasLabel: the shop's own term for its reference price (config.shown_was.was_label), e.g. "with a raised list price".
 */
export function ratingSentence(c: { judged: number; avoid: number; wasRaised: number }, wasLabel?: string | null): string {
  const products = c.judged === 1 ? 'product' : 'products';
  const verb = c.avoid === 1 ? 'was a Deal to Avoid' : 'were Deals to Avoid';
  return `${count.format(c.avoid)} of ${count.format(c.judged)} judged ${products} ${verb} (${count.format(c.wasRaised)} with a raised ${wasTerms(wasLabel).inner}).`;
}

export function computeRating(
  c: { judged: number; good: number; avoid: number; wasRaised: number },
  t: Thresholds,
  wasLabel?: string | null,
): { grade: Grade | null; sentence: string } {
  // written as negations so a missing or NaN count (or minimum) also means "not rated", never a letter
  if (!(c.judged > 0) || !(c.judged >= t.minJudgedForRating)) {
    return { grade: null, sentence: NOT_RATED_SENTENCE };
  }
  // avoid share plus half the raised share, in one division to keep the band edges exact
  const score = (c.avoid + c.wasRaised * 0.5) / c.judged;
  if (!Number.isFinite(score)) return { grade: null, sentence: NOT_RATED_SENTENCE };
  const band = BANDS.find((b) => score < b.below);
  return { grade: band ? band.grade : 'F', sentence: ratingSentence(c, wasLabel) };
}
