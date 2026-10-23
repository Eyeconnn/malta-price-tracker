import { describe, expect, it } from 'vitest';
import { recheckStored, type StoredName } from '../../src/names/recheck.js';
import { loadAttributeSchemas } from '../../src/names/schema.js';
import type { GroupInput } from '../../src/names/select.js';

const schemas = await loadAttributeSchemas();
function group(over: Partial<GroupInput>): GroupInput {
  return {
    shopId: 1, shopSlug: 'shop', groupKey: 'g', title: 't', brand: null, category: 'other', categoryPath: null,
    gtin: null, mpn: null, variantTitles: [], storedHash: null, ...over,
  };
}

describe('recheckStored (--recheck-stored, no model call)', () => {
  it('runs the current checks over stored ok names and returns the ones that now fail, with the reason', () => {
    const groups = [
      group({ groupKey: 'pro', category: 'phones', title: 'Apple iPhone 15 Pro Screen Protector', brand: 'Apple' }),
      group({ groupKey: 'fine', category: 'phones', title: 'Apple iPhone 15 Screen Protector', brand: 'Apple' }),
      group({ groupKey: 'gone', category: 'phones', title: 'Not stored', brand: null }),
    ];
    const stored: StoredName[] = [
      { shopId: 1, groupKey: 'pro', category: 'phones', displayName: 'Apple iPhone 15 Screen Protector', variantLabel: null, attrs: {} },
      { shopId: 1, groupKey: 'fine', category: 'phones', displayName: 'Apple iPhone 15 Screen Protector', variantLabel: null, attrs: {} },
      { shopId: 1, groupKey: 'stale', category: 'phones', displayName: 'Old', variantLabel: null, attrs: {} },
    ];
    const r = recheckStored(groups, stored, schemas);
    expect(r.checked).toBe(2);
    expect(r.failing.map((f) => [f.groupKey, f.reason])).toEqual([['pro', 'lost tokens: pro']]);
  });
});
