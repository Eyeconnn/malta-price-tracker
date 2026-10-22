import { describe, expect, it } from 'vitest';
import { computeRating } from '../../src/site/rating.js';
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

  it('gives the exact sentence for each grade', () => {
    expect(grade(0).sentence).toBe('Honest pricing. Its deals are real discounts.');
    expect(grade(5).sentence).toBe('Mostly honest. A few deals need a closer look.');
    expect(grade(10).sentence).toBe('Mixed. Check each deal before you buy.');
    expect(grade(20).sentence).toBe('Be careful here. Some Black Friday prices were raised before the sale.');
    expect(grade(30).sentence).toBe('Many deals here were raised before the sale.');
    expect(grade(50).sentence).toBe('Avoid its deals. Most were raised before the sale.');
  });
});
