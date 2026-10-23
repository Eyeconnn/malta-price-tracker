import { describe, expect, it } from 'vitest';
import { budgetReached, checkRunScope, FailureBreaker, parseEffort, parseMaxCost } from '../../src/names/options.js';

describe('checkRunScope', () => {
  it('refuses a run that writes to the database without --pilot or --max-batches', () => {
    expect(() => checkRunScope({ dryRun: false, pilot: false, maxBatches: undefined })).toThrow(/--pilot or --max-batches/);
  });

  it('allows dry runs, pilot runs and capped runs', () => {
    expect(() => checkRunScope({ dryRun: true, pilot: false, maxBatches: undefined })).not.toThrow();
    expect(() => checkRunScope({ dryRun: false, pilot: true, maxBatches: undefined })).not.toThrow();
    expect(() => checkRunScope({ dryRun: false, pilot: false, maxBatches: 5 })).not.toThrow();
  });
});

describe('parseEffort', () => {
  it('accepts the CLI levels, undefined for the CLI default, and refuses anything else', () => {
    expect(parseEffort(undefined)).toBeUndefined();
    expect(parseEffort(' low ')).toBe('low');
    expect(parseEffort('xhigh')).toBe('xhigh');
    expect(() => parseEffort('turbo')).toThrow(/--effort must be one of low, medium, high, xhigh, max/);
  });
});

describe('parseMaxCost and budgetReached (--max-cost for the nightly run)', () => {
  it('reads a positive dollar amount, undefined when not given, and refuses anything else', () => {
    expect(parseMaxCost(undefined)).toBeUndefined();
    expect(parseMaxCost('5')).toBe(5);
    expect(parseMaxCost(' 0.25 ')).toBe(0.25);
    for (const bad of ['0', '-1', 'five', '', 'Infinity']) expect(() => parseMaxCost(bad)).toThrow(/--max-cost/);
  });

  it('stops starting batches once the summed reported cost reaches the cap', () => {
    expect(budgetReached(4.99, 5)).toBe(false);
    expect(budgetReached(5, 5)).toBe(true);
    expect(budgetReached(7, 5)).toBe(true);
    expect(budgetReached(1000, undefined)).toBe(false);
  });
});

describe('FailureBreaker (review I6/I7)', () => {
  it('stops after 5 failed batches in a row; a good batch resets the count', () => {
    const b = new FailureBreaker();
    for (let i = 0; i < 4; i++) expect(b.record(false, 'claude timed out after 300s')).toBe('continue');
    expect(b.record(true)).toBe('continue');
    for (let i = 0; i < 4; i++) expect(b.record(false, 'claude exited with code 1')).toBe('continue');
    expect(b.record(false, 'claude exited with code 1')).toBe('consecutive');
  });

  it('stops at once on a login or usage-limit error', () => {
    for (const e of [
      'claude reported an error: Claude AI usage limit reached|1761300000',
      'claude exited with code 1: Invalid API key \u00b7 Please run /login',
      'claude reported an error: OAuth token has expired',
      "claude reported an error: You've hit your limit \u00b7 resets 3am",
      'claude exited with code 1: 401 Unauthorized',
    ]) {
      expect(new FailureBreaker().record(false, e)).toBe('auth');
    }
  });
});
