import { describe, expect, it } from 'vitest';
import { recheckCanonical, splitBackfill } from '../../src/names/backfill.js';
import type { GroupInput } from '../../src/names/select.js';

function group(over: Partial<GroupInput>): GroupInput {
  return {
    shopId: 1, shopSlug: 'shop', groupKey: 'g', title: 't', brand: null, category: 'phones', categoryPath: null,
    gtin: null, mpn: null, variantTitles: [], storedHash: null, storedStatus: 'ok', storedCanonicalStatus: null, ...over,
  };
}

describe('splitBackfill (--backfill-canonical)', () => {
  it('gives a canonical name from the stored fields without a model call when they pass the check, and sends the rest to the model', () => {
    const fromStored = group({ groupKey: 'a', title: 'Apple iPhone 15 128GB Black', brand: 'Apple', storedAttrs: { brand: 'Apple', model: 'iPhone 15', storage_gb: 128, colour: ['Black'] }, storedNameCategory: 'phones' });
    const lacking = group({ groupKey: 'b', title: 'Apple iPhone 15 Plus 128GB Black', brand: 'Apple', storedAttrs: { brand: 'Apple', model: 'iPhone 15', storage_gb: 128 } });
    const none = group({ groupKey: 'c', title: 'Nike Air Max 90', brand: 'Nike', storedAttrs: {} });
    const r = splitBackfill([fromStored, lacking, none]);
    expect(r.direct).toEqual([{ group: fromStored, canonicalName: 'apple iphone15 128gb' }]);
    expect(r.needModel.map((g) => g.groupKey)).toEqual(['b', 'c']);
  });
});

describe('recheckCanonical (--recheck-canonical, and the first step of --backfill-canonical)', () => {
  it('rewrites stored canonical names the current rules write otherwise, demotes the ones that fail, and leaves the rest', () => {
    const attrs = { brand: 'Apple', model: 'iPhone 15', storage_gb: 128, colour: ['Black'] };
    const same = group({ groupKey: 'same', title: 'Apple iPhone 15 128GB Black', storedCanonicalStatus: 'ok', storedCanonicalName: 'apple iphone15 128gb', storedAttrs: attrs, storedNameCategory: 'phones' });
    const renamed = group({ groupKey: 'renamed', title: 'Apple iPhone 15 128GB Black', storedCanonicalStatus: 'ok', storedCanonicalName: 'apple iphone 15 128gb', storedAttrs: attrs, storedNameCategory: 'phones' });
    const failing = group({ groupKey: 'failing', title: 'Apple iPhone 15 Plus 128GB Black', storedCanonicalStatus: 'ok', storedCanonicalName: 'apple iphone15 128gb', storedAttrs: attrs, storedNameCategory: 'phones' });
    const moved = group({ groupKey: 'moved', title: 'Apple iPhone 15 128GB Black', storedCanonicalStatus: 'ok', storedCanonicalName: 'apple iphone15 128gb', storedAttrs: attrs, storedNameCategory: 'tv-audio' });
    const untried = group({ groupKey: 'untried', title: 'Apple iPhone 15 128GB Black', storedCanonicalStatus: null, storedAttrs: attrs, storedNameCategory: 'phones' });
    const r = recheckCanonical([same, renamed, failing, moved, untried]);
    expect(r.checked).toBe(4);
    expect(r.updates).toEqual([
      { shopId: 1, groupKey: 'renamed', canonicalName: 'apple iphone15 128gb', reason: null },
      { shopId: 1, groupKey: 'failing', canonicalName: null, reason: 'recheck: lost tokens: plus' },
      { shopId: 1, groupKey: 'moved', canonicalName: null, reason: 'recheck: category changed (tv-audio to phones)' },
    ]);
  });
});
