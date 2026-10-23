import { describe, expect, it } from 'vitest';
import { SITE_CATEGORIES } from '../../src/site/categories.js';
import { interleaveBatches, makeBatches, systemPrompt, userMessage } from '../../src/names/prompt.js';
import { answerJsonSchema, loadAttributeSchemas } from '../../src/names/schema.js';
import type { GroupInput } from '../../src/names/select.js';

const schemas = await loadAttributeSchemas();

function group(over: Partial<GroupInput>): GroupInput {
  return {
    shopId: 1, shopSlug: 'shop', groupKey: 'g', title: 't', brand: null, category: 'other', categoryPath: null,
    gtin: null, mpn: null, variantTitles: [], storedHash: null, ...over,
  };
}

describe('attribute schemas', () => {
  it('has an attribute list for every site category, colours from the shared list', () => {
    expect(Object.keys(schemas).sort()).toEqual(SITE_CATEGORIES.map((c) => c.slug).sort());
    for (const schema of Object.values(schemas)) {
      for (const spec of Object.values(schema)) {
        expect(spec.meaning.length).toBeGreaterThan(0);
        if (spec.type === 'enum') expect(spec.values!.length).toBeGreaterThan(0);
        if (spec.type === 'number') expect(spec.unit && spec.min !== undefined && spec.max !== undefined).toBeTruthy();
      }
    }
    expect(schemas.fashion.colour.values).toEqual(schemas.laptops.colour.values);
  });

  it('builds a JSON schema that only allows the category keys', () => {
    const js = answerJsonSchema(schemas.laptops) as { properties: { items: { items: { properties: { attrs: { properties: object; additionalProperties: boolean } } } } } };
    const attrs = js.properties.items.items.properties.attrs;
    expect(Object.keys(attrs.properties).sort()).toEqual(Object.keys(schemas.laptops).sort());
    expect(attrs.additionalProperties).toBe(false);
  });
});

describe('interleaveBatches', () => {
  it('takes one batch of each category in turn, so a capped night covers every category', () => {
    const groups = [
      ...Array.from({ length: 7 }, (_, i) => group({ category: 'toys', groupKey: `t${i}` })),
      ...Array.from({ length: 2 }, (_, i) => group({ category: 'drinks', groupKey: `d${i}` })),
      group({ category: 'laptops', groupKey: 'l0' }),
    ];
    const order = interleaveBatches(makeBatches(groups, 2)).map((b) => b.category);
    expect(order).toEqual(['laptops', 'toys', 'drinks', 'toys', 'toys', 'toys']);
    // still one category per batch
    expect(interleaveBatches(makeBatches(groups, 2)).every((b) => new Set(b.items.map((i) => i.group.category)).size === 1)).toBe(true);
  });
});

describe('makeBatches', () => {
  const groups = [
    ...Array.from({ length: 7 }, (_, i) => group({ category: 'laptops', groupKey: `l${i}` })),
    ...Array.from({ length: 5 }, (_, i) => group({ category: 'toys', groupKey: `t${i}` })),
  ].sort(() => 0.5 - Math.random());

  it('never mixes categories in a batch and keeps every group once', () => {
    const batches = makeBatches(groups, 3);
    for (const b of batches) {
      expect(b.items.length).toBeLessThanOrEqual(3);
      expect(new Set(b.items.map((i) => i.group.category))).toEqual(new Set([b.category]));
      expect(new Set(b.items.map((i) => i.key)).size).toBe(b.items.length);
    }
    const all = batches.flatMap((b) => b.items.map((i) => i.group.groupKey)).sort();
    expect(all).toEqual(groups.map((g) => g.groupKey).sort());
    expect(batches.filter((b) => b.category === 'laptops')).toHaveLength(3);
  });

  it('puts groups without a known category into other', () => {
    const batches = makeBatches([group({ category: 'nonsense' })], 10);
    expect(batches[0].category).toBe('other');
  });
});

describe('systemPrompt', () => {
  const p = systemPrompt('laptops', schemas.laptops);

  it('lists the category attribute keys with units and allowed values', () => {
    expect(p).toContain('ram_gb');
    expect(p).toContain('storage_type');
    expect(p).toContain('SSD');
    expect(p).not.toContain('abv_pct');
  });

  it('holds the safety rules and treats shop text as data', () => {
    expect(p).toMatch(/never invent/i);
    expect(p).toMatch(/addressed to an AI/i);
    expect(p).toMatch(/never add a unit/i);
    expect(p).toMatch(/only words that appear in the data/i);
    expect(p).toMatch(/web address/i);
    expect(p).toMatch(/brand/i);
    expect(p).not.toContain('\u2014');
  });

  it('says to keep set numbers, model numbers and product codes, and never to swap the maker the title names', () => {
    expect(p).toMatch(/always keep set numbers, model numbers and product codes/i);
    for (const code of ['77247', '40922', '19348', 'T500WHT']) expect(p).toContain(code);
    expect(p).toMatch(/never replace it with another brand/i);
    expect(p).toContain('Therabody');
  });

  it('says to keep the condition and any value with a currency in display_name (review C1)', () => {
    const p = systemPrompt('gaming', schemas.gaming);
    expect(p).toMatch(/condition[^.]*Pre-owned[^.]*Refurbished[^.]*Open Box[^.]*Grade A[^.]*display_name/);
    expect(p).toMatch(/currency[^.]*€20[^.]*20 EUR[^.]*display_name/);
  });

  it('says to keep the not_the_brand value when the title contains it', () => {
    expect(systemPrompt('toys', schemas.toys)).toMatch(/not_the_brand[^.]*\. When the title contains it, keep it/);
  });
});

describe('userMessage', () => {
  it('is one JSON line per product, with the batch keys and no empty fields', () => {
    const [batch] = makeBatches([group({ category: 'toys', title: 'LEGO 42115', brand: 'LEGO', variantTitles: ['Default Title'] }), group({ category: 'toys', title: 'Barbie', groupKey: 'b' })], 10);
    const lines = userMessage(batch).split('\n').filter((l) => l.startsWith('{'));
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toEqual({ key: '1', title: 'LEGO 42115', brand: 'LEGO' });
    expect(JSON.parse(lines[1])).toEqual({ key: '2', title: 'Barbie' });
  });

  it('sends a reliable brand as brand and an unreliable one only flagged, so the model does not add it', () => {
    const [batch] = makeBatches([
      group({ category: 'fashion', title: '15 Denier Matt Sheer Hold-Ups', brand: 'Calzedonia Malta', brandStatus: 'unreliable' }),
      group({ category: 'fashion', title: 'Train Essentials Train Cotton 3-Stripes Pacer Shorts', brand: 'Adidas Performance', brandStatus: 'reliable', groupKey: 'b' }),
      group({ category: 'fashion', title: 'Striped Baby Yoda slippers', brand: '4993716', brandStatus: 'none', groupKey: 'c' }),
    ], 10);
    const [a, b, c] = userMessage(batch).split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    expect(a).toEqual({ key: '1', title: '15 Denier Matt Sheer Hold-Ups', not_the_brand: 'Calzedonia Malta' });
    expect(b).toEqual({ key: '2', title: 'Train Essentials Train Cotton 3-Stripes Pacer Shorts', brand: 'Adidas Performance' });
    expect(c).toEqual({ key: '3', title: 'Striped Baby Yoda slippers' });
    const p = systemPrompt('fashion', schemas.fashion);
    expect(p).toContain('not_the_brand');
    expect(p).toMatch(/never add it/i);
  });

  it('keeps at most 30 variant titles', () => {
    const [batch] = makeBatches([group({ variantTitles: Array.from({ length: 50 }, (_, i) => `v${i}`) })], 10);
    const line = JSON.parse(userMessage(batch).split('\n').find((l) => l.startsWith('{'))!);
    expect(line.variants).toHaveLength(30);
  });
});
