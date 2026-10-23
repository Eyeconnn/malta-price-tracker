import { describe, expect, it } from 'vitest';
import { renderCsv, type ReportRow } from '../../src/names/report.js';
import { parseCsv, pickSample, readSampleCsv } from '../../src/names/sample.js';
import type { GroupInput } from '../../src/names/select.js';

function group(over: Partial<GroupInput>): GroupInput {
  return {
    shopId: 1, shopSlug: 'shop', groupKey: 'g', title: 't', brand: null, category: 'other', categoryPath: null,
    gtin: null, mpn: null, variantTitles: [], storedHash: null, ...over,
  };
}

// the header and two rows as the pilot of 2026-10-22 wrote them (out/names/dry-20261022-222157-haiku.csv)
const OLD_CSV = '\uFEFFcategory,shop,source_title,clean_name,variant_label,attributes,dropped_attributes,status,reason\r\n' +
  'drinks,okfashion,U.S. POLO ASSN. WOMEN TOWNIE BELT WOMAN H35 IN WINE,U.S. Polo Assn. Women Townie Belt Woman H35,,,,rejected,brand OKFASHION.COM.MT missing\r\n' +
  'appliances,crosscraft,"Severin Black Line Single XXL Air Fryer, 7L",Severin Black Line Single XXL Air Fryer 7L,,brand: Severin; appliance_type: air fryer; capacity_l: 7,,ok,\r\n' +
  "tv-audio,retail,Electronic Products,Electronic Products,,,,ok,\r\n" +
  "tv-audio,retail,Electronic Products,Electronic Products,,,,ok,\r\n" +
  "toys,toyshop,\"'-30% LEGO 42115\",LEGO 42115,,,,ok,\r\n" +
  'toys,gone,A group that is no longer fresh,x,,,,ok,\r\n';

describe('parseCsv and readSampleCsv', () => {
  it('reads quoted cells, the BOM, CRLF and the apostrophe that guards formula cells', () => {
    const rows = parseCsv(OLD_CSV);
    expect(rows[0][0]).toBe('category');
    expect(rows[2][2]).toBe('Severin Black Line Single XXL Air Fryer, 7L');
    const sample = readSampleCsv(OLD_CSV);
    expect(sample).toHaveLength(6);
    expect(sample[4].sourceTitle).toBe('-30% LEGO 42115');
    expect(sample[0]).toEqual({ category: 'drinks', shop: 'okfashion', sourceTitle: 'U.S. POLO ASSN. WOMEN TOWNIE BELT WOMAN H35 IN WINE', shopId: null, groupKey: null });
  });

  it('reads back what renderCsv writes, with shop_id and group_key', () => {
    const rows: ReportRow[] = [{ category: 'toys', shop: 'toyshop', sourceTitle: '=HYPERLINK("x"), 2', name: 'x', variantLabel: null, attrs: {}, dropped: [], status: 'ok', reason: null, shopId: 9, groupKey: 'k,1', brand: null, brandStatus: 'none' }];
    expect(readSampleCsv(renderCsv(rows))).toEqual([{ category: 'toys', shop: 'toyshop', sourceTitle: '=HYPERLINK("x"), 2', shopId: 9, groupKey: 'k,1' }]);
  });
});

describe('pickSample', () => {
  const groups = [
    group({ shopId: 2, shopSlug: 'okfashion', groupKey: 'belt', title: 'U.S. POLO ASSN. WOMEN TOWNIE BELT WOMAN H35 IN WINE', category: 'fashion' }),
    group({ shopId: 3, shopSlug: 'crosscraft', groupKey: 'fryer', title: 'Severin Black Line Single XXL Air Fryer, 7L', category: 'appliances' }),
    group({ shopId: 4, shopSlug: 'retail', groupKey: 'e1', title: 'Electronic Products', category: 'tv-audio' }),
    group({ shopId: 4, shopSlug: 'retail', groupKey: 'e2', title: 'Electronic Products', category: 'tv-audio' }),
    group({ shopId: 5, shopSlug: 'toyshop', groupKey: 'lego', title: '-30% LEGO 42115', category: 'toys' }),
    group({ shopId: 5, shopSlug: 'toyshop', groupKey: 'other', title: 'Not in the sample', category: 'toys' }),
  ];

  it('picks exactly the groups of an old CSV by shop and title, each group once, and counts the category changes', () => {
    const r = pickSample(groups, readSampleCsv(OLD_CSV));
    expect(r.chosen.map((g) => g.groupKey)).toEqual(['belt', 'fryer', 'e1', 'e2', 'lego']);
    expect(r.matched).toBe(5);
    expect(r.byIds).toBe(0);
    expect(r.missing.map((m) => m.shop)).toEqual(['gone']);
    expect(r.changedCategory.map((c) => [c.from, c.to])).toEqual([['drinks', 'fashion']]);
  });

  it('matches on shop_id and group_key when the CSV has them, also when the title changed', () => {
    const rows = [{ category: 'toys', shop: 'toyshop', sourceTitle: 'LEGO 42115 (old title)', shopId: 5, groupKey: 'lego' }];
    const r = pickSample(groups, rows);
    expect(r.chosen.map((g) => g.groupKey)).toEqual(['lego']);
    expect(r.byIds).toBe(1);
  });
});
