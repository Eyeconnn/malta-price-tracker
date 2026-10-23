import { describe, expect, it } from 'vitest';
import { changedGroups, pilotSample, titleHash, type GroupInput } from '../../src/names/select.js';

function group(over: Partial<GroupInput>): GroupInput {
  return {
    shopId: 1, shopSlug: 'shop', groupKey: 'g', title: 't', brand: null, category: 'other', categoryPath: null,
    gtin: null, mpn: null, variantTitles: [], storedHash: null, ...over,
  };
}

describe('titleHash', () => {
  it('ignores case, extra spaces and variant order', () => {
    expect(titleHash('Nike  Air Max', ['M', 'L'])).toBe(titleHash('nike air max ', ['l', 'm']));
  });

  it('changes when the title or a variant title changes', () => {
    const base = titleHash('Nike Air Max', ['M', 'L']);
    expect(titleHash('Nike Air Max 90', ['M', 'L'])).not.toBe(base);
    expect(titleHash('Nike Air Max', ['M', 'XL'])).not.toBe(base);
  });

  it('is a sha256 hex string', () => {
    expect(titleHash('x', [])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('changedGroups', () => {
  it('skips groups whose stored title_hash is unchanged and keeps new or changed ones', () => {
    const same = group({ groupKey: 'same', title: 'A', variantTitles: ['1'], storedHash: titleHash('A', ['1']) });
    const changed = group({ groupKey: 'changed', title: 'B', storedHash: titleHash('old B', []) });
    const fresh = group({ groupKey: 'new', title: 'C' });
    expect(changedGroups([same, changed, fresh]).map((g) => g.groupKey)).toEqual(['changed', 'new']);
  });

  it('--backfill-canonical: only names stored ok and never tried for a canonical name; tried and rejected ones with --retry-rejected', () => {
    const lacking = group({ groupKey: 'lacking', title: 'A', storedHash: titleHash('A', []), storedStatus: 'ok', storedCanonicalStatus: null });
    const has = group({ groupKey: 'has', title: 'B', storedHash: titleHash('B', []), storedStatus: 'ok', storedCanonicalStatus: 'ok' });
    const tried = group({ groupKey: 'tried', title: 'E', storedHash: titleHash('E', []), storedStatus: 'ok', storedCanonicalStatus: 'rejected' });
    const rejected = group({ groupKey: 'rejected', title: 'C', storedHash: titleHash('C', []), storedStatus: 'rejected', storedCanonicalStatus: null });
    const fresh = group({ groupKey: 'new', title: 'D' });
    const all = [lacking, has, tried, rejected, fresh];
    expect(changedGroups(all, { backfillCanonical: true }).map((g) => g.groupKey)).toEqual(['lacking']);
    expect(changedGroups(all, { backfillCanonical: true, retryRejected: true }).map((g) => g.groupKey)).toEqual(['lacking', 'tried']);
  });
});

describe('pilotSample', () => {
  const groups: GroupInput[] = [];
  for (const category of ['laptops', 'toys', 'drinks']) {
    for (const shopId of [1, 2, 3]) {
      for (let i = 0; i < 40; i++) groups.push(group({ category, shopId, groupKey: `${category}-${shopId}-${i}` }));
    }
  }
  groups.push(group({ category: 'baby', shopId: 4, groupKey: 'baby-only' }));

  it('takes up to ceil(N / categories) per category, never more than N in total', () => {
    const s = pilotSample(groups, 30, 'seed');
    expect(s.length).toBeLessThanOrEqual(30);
    const per = new Map<string, number>();
    for (const g of s) per.set(g.category, (per.get(g.category) ?? 0) + 1);
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(Math.ceil(30 / 4));
    expect(per.get('baby')).toBe(1);
    expect([...per.keys()].sort()).toEqual(['baby', 'drinks', 'laptops', 'toys']);
  });

  it('spreads each category over its shops round-robin', () => {
    const s = pilotSample(groups, 24, 'seed').filter((g) => g.category === 'toys');
    const shops = s.map((g) => g.shopId);
    expect(new Set(shops)).toEqual(new Set([1, 2, 3]));
    const count = (id: number) => shops.filter((x) => x === id).length;
    expect(Math.max(count(1), count(2), count(3)) - Math.min(count(1), count(2), count(3))).toBeLessThanOrEqual(1);
  });

  it('is deterministic for a seed and differs for another seed', () => {
    const keys = (seed: string) => pilotSample(groups, 30, seed).map((g) => g.groupKey);
    expect(keys('a')).toEqual(keys('a'));
    expect(keys('a')).not.toEqual(keys('b'));
  });

  it('returns no duplicates', () => {
    const s = pilotSample(groups, 500, 'seed');
    expect(new Set(s.map((g) => g.groupKey)).size).toBe(s.length);
    expect(s.length).toBe(groups.length);
  });
});

describe('changedGroups with --retry-rejected', () => {
  it('re-queues stored rejected groups even when their title is unchanged', () => {
    const okSame = group({ groupKey: 'ok', title: 'A', storedHash: titleHash('A', []), storedStatus: 'ok' });
    const rejSame = group({ groupKey: 'rej', title: 'B', storedHash: titleHash('B', []), storedStatus: 'rejected' });
    expect(changedGroups([okSame, rejSame]).map((g) => g.groupKey)).toEqual([]);
    expect(changedGroups([okSame, rejSame], { retryRejected: true }).map((g) => g.groupKey)).toEqual(['rej']);
  });
});
