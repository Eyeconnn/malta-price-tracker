// Shop rating: how many of a shop's judged Black Friday deals were raised before the sale.
import type { Thresholds } from './settings.js';

export type Grade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

// A band applies while the score is strictly under `below`.
const BANDS: { below: number; grade: Grade; sentence: string }[] = [
  { below: 0.05, grade: 'A', sentence: 'Honest pricing. Its deals are real discounts.' },
  { below: 0.1, grade: 'B', sentence: 'Mostly honest. A few deals need a closer look.' },
  { below: 0.2, grade: 'C', sentence: 'Mixed. Check each deal before you buy.' },
  { below: 0.3, grade: 'D', sentence: 'Be careful here. Some Black Friday prices were raised before the sale.' },
  { below: 0.45, grade: 'E', sentence: 'Many deals here were raised before the sale.' },
];

const GRADE_F = { grade: 'F' as Grade, sentence: 'Avoid its deals. Most were raised before the sale.' };

export function computeRating(
  c: { judged: number; good: number; avoid: number; wasRaised: number },
  t: Thresholds,
): { grade: Grade | null; sentence: string } {
  if (c.judged <= 0 || c.judged < t.minJudgedForRating) {
    return { grade: null, sentence: 'Not rated yet: not enough Black Friday deals checked.' };
  }
  // avoid share plus half the raised share, in one division to keep the band edges exact
  const score = (c.avoid + c.wasRaised * 0.5) / c.judged;
  const band = BANDS.find((b) => score < b.below);
  return band ? { grade: band.grade, sentence: band.sentence } : GRADE_F;
}
