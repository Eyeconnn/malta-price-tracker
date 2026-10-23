import { describe, expect, it } from 'vitest';
import { splitBackfill } from '../../src/names/backfill.js';
import type { GroupInput } from '../../src/names/select.js';

function group(over: Partial<GroupInput>): GroupInput {
  return {
    shopId: 1, shopSlug: 'shop', groupKey: 'g', title: 't', brand: null, category: 'phones', categoryPath: null,
    gtin: null, mpn: null, variantTitles: [], storedHash: null, storedStatus: 'ok', storedCanonicalStatus: null, ...over,
  };
}

describe('splitBackfill (--backfill-canonical)', () => {
  it('gives a canonical name from the stored fields without a model call when they pass the check, and sends the rest to the model', () => {
    const fromStored = group({ groupKey: 'a', title: 'Apple iPhone 15 128GB Black', brand: 'Apple', storedAttrs: { brand: 'Apple', model: 'iPhone 15', storage_gb: 128 }, storedNameCategory: 'phones' });
    const lacking = group({ groupKey: 'b', title: 'Apple iPhone 15 Plus 128GB Black', brand: 'Apple', storedAttrs: { brand: 'Apple', model: 'iPhone 15', storage_gb: 128 } });
    const none = group({ groupKey: 'c', title: 'Nike Air Max 90', brand: 'Nike', storedAttrs: {} });
    const r = splitBackfill([fromStored, lacking, none]);
    expect(r.direct).toEqual([{ group: fromStored, canonicalName: 'apple iphone15 128gb' }]);
    expect(r.needModel.map((g) => g.groupKey)).toEqual(['b', 'c']);
  });
});
