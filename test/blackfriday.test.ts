import { describe, expect, it } from 'vitest';
import { classify, detectBlackFriday } from '../src/util/blackfriday.js';
import { blankRecord } from '../src/util/normalise.js';

describe('classify', () => {
  it.each([
    ['Black Friday', 'marked'],
    ['category=Black Friday 30%', 'marked'],
    ['30% BF', 'marked'],
    ['BF26', 'marked'],
    ['BF-2026', 'marked'],
    ['Black Friday Deals', 'marked'],
    ['BF2025', 'stale'],
    ['BF25', 'stale'],
    ['CYBERMONDAY2024', 'stale'],
    ['Black Friday 2025', 'stale'],
    ['NOTINCBF25', 'stale'],
    ['NOTINCBF26', 'excluded'],
    ['Not in Black Friday', 'excluded'],
  ])('%s -> %s', (text, status) => expect(classify(text)).toBe(status));

  it.each(['BF20401', 'Bfg', 'Beach Fun', 'Friday Night', 'Boys'])('%s is not a marker', (text) => expect(classify(text)).toBeNull());
});

describe('detectBlackFriday', () => {
  it('prefers excluded, then marked, then stale', () => {
    const r = { ...blankRecord('1'), tags: ['BF2025', 'Black Friday', 'NOTINCBF26'] };
    expect(detectBlackFriday(r)?.status).toBe('excluded');
    const s = { ...blankRecord('2'), tags: ['BF2025'], category_path: 'Toys | Black Friday Deals' };
    expect(detectBlackFriday(s)).toEqual({ status: 'marked', marker: 'category: Black Friday Deals' });
  });
  it('uses Shopify collection membership and ignores titles', () => {
    const r = { ...blankRecord('3'), meta: { bf_collection: 'Black Friday' } };
    expect(detectBlackFriday(r)?.marker).toBe('collection: Black Friday');
    const t = { ...blankRecord('4'), title: 'Black Friday Board Game' };
    expect(detectBlackFriday(t)).toBeNull();
  });
});
