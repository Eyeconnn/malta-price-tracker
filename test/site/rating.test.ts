import { describe, expect, it } from 'vitest';
import { computeRating, ratingSentence } from '../../src/site/rating.js';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';

const T = DEFAULT_SETTINGS.thresholds;

function grade(avoid: number, wasRaised = 0, judged = 100) {
  return computeRating({ judged, good: judged - avoid, avoid, wasRaised }, T);
}

describe('computeRating', () => {
  it('uses "under" bands on the avoid share', () => {
    expect(grade(4).grade).toBe('A');
    expect(grade(5).grade).toBe('B');
    expect(grade(9).grade).toBe('B');
    expect(grade(10).grade).toBe('C');
    expect(grade(19).grade).toBe('C');
    expect(grade(20).grade).toBe('D');
    expect(grade(29).grade).toBe('D');
    expect(grade(30).grade).toBe('E');
    expect(grade(44).grade).toBe('E');
    expect(grade(45).grade).toBe('F');
    expect(grade(100).grade).toBe('F');
  });

  it('adds half the raised share to the score', () => {
    expect(grade(15, 20).grade).toBe('D');
    expect(grade(0, 20).grade).toBe('C');
    expect(grade(0, 0).grade).toBe('A');
  });

  it('is not rated below the minimum number of judged products', () => {
    const r = computeRating({ judged: 19, good: 19, avoid: 0, wasRaised: 0 }, T);
    expect(r.grade).toBeNull();
    expect(r.sentence).toBe('Not rated yet: not enough Black Friday deals checked.');
    expect(computeRating({ judged: 0, good: 0, avoid: 0, wasRaised: 0 }, T).grade).toBeNull();
    expect(computeRating({ judged: 20, good: 20, avoid: 0, wasRaised: 0 }, T).grade).toBe('A');
  });

  it('respects a custom minimum', () => {
    expect(computeRating({ judged: 5, good: 5, avoid: 0, wasRaised: 0 }, { ...T, minJudgedForRating: 5 }).grade).toBe('A');
  });

  it('never rates a shop with no judged products, even when the minimum is zero', () => {
    expect(computeRating({ judged: 0, good: 0, avoid: 0, wasRaised: 0 }, { ...T, minJudgedForRating: 0 }).grade).toBeNull();
  });

  it('states the counts behind the letter, never a judgement about the shop (Ruling R54)', () => {
    expect(grade(0).sentence).toBe('0 of 100 judged products were Deals to Avoid (0 with a raised was price).');
    expect(grade(23, 9, 120).sentence).toBe('23 of 120 judged products were Deals to Avoid (9 with a raised was price).');
    expect(grade(1, 1, 40).sentence).toBe('1 of 40 judged products was a Deal to Avoid (1 with a raised was price).');
    expect(computeRating({ judged: 1, good: 0, avoid: 1, wasRaised: 0 }, { ...T, minJudgedForRating: 1 }).sentence).toBe(
      '1 of 1 judged product was a Deal to Avoid (0 with a raised was price).',
    );
    expect(grade(1500, 0, 2500).sentence).toBe('1,500 of 2,500 judged products were Deals to Avoid (0 with a raised was price).');
    // the letters and bands stay as they were
    expect(grade(4).grade).toBe('A');
    expect(grade(45).grade).toBe('F');
  });

  it('is not rated when the counts are not numbers (M5)', () => {
    for (const judged of [Number.NaN, Number.POSITIVE_INFINITY * 0, undefined as unknown as number]) {
      const r = computeRating({ judged, good: 0, avoid: 0, wasRaised: 0 }, T);
      expect(r.grade).toBeNull();
      expect(r.sentence).toBe('Not rated yet: not enough Black Friday deals checked.');
    }
    expect(computeRating({ judged: 30, good: 30, avoid: 0, wasRaised: 0 }, { ...T, minJudgedForRating: Number.NaN }).grade).toBeNull();
    expect(computeRating({ judged: 30, good: 30, avoid: Number.NaN, wasRaised: 0 }, T).grade).toBeNull();
  });
});

describe("rating sentence in the shop's own term (was_label)", () => {
  it('names a raised reference price by the term', () => {
    expect(ratingSentence({ judged: 120, avoid: 23, wasRaised: 9 }, 'List price')).toBe(
      '23 of 120 judged products were Deals to Avoid (9 with a raised list price).',
    );
    expect(ratingSentence({ judged: 120, avoid: 23, wasRaised: 9 })).toBe('23 of 120 judged products were Deals to Avoid (9 with a raised was price).');
  });
});
