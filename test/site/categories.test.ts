import { describe, expect, it } from 'vitest';
import { CATEGORY_RULES, SITE_CATEGORIES, categorize } from '../../src/site/categories.js';

function input(over: Partial<Parameters<typeof categorize>[0]> = {}): Parameters<typeof categorize>[0] {
  return { categoryPath: null, tags: [], title: null, shopCategory: null, ...over };
}

describe('SITE_CATEGORIES', () => {
  it('lists the categories in display order with names', () => {
    expect(SITE_CATEGORIES.map((c) => c.slug)).toEqual([
      'laptops', 'phones', 'tv-audio', 'gaming', 'appliances', 'toys', 'baby', 'fashion',
      'beauty-health', 'home-kitchen', 'sports', 'drinks', 'other',
    ]);
    expect(SITE_CATEGORIES.find((c) => c.slug === 'phones')?.name).toBe('Phones & tablets');
  });

  it('only has rules for known slugs', () => {
    const slugs = new Set(SITE_CATEGORIES.map((c) => c.slug));
    for (const r of CATEGORY_RULES) expect(slugs.has(r.slug)).toBe(true);
  });
});

describe('categorize', () => {
  it('uses the category path', () => {
    expect(categorize(input({ categoryPath: 'Laptops > Gaming Laptops' }))).toBe('laptops');
    expect(categorize(input({ categoryPath: 'Smart Phones' }))).toBe('phones');
  });

  it('checks the category path before the title', () => {
    expect(categorize(input({ title: 'Apple iPhone 17 256GB', categoryPath: 'Smart Phones' }))).toBe('phones');
    expect(categorize(input({ title: 'Apple iPhone 17 256GB', categoryPath: 'Laptops' }))).toBe('laptops');
  });

  it('falls back to tags then title', () => {
    expect(categorize(input({ tags: ['Soundbars'], title: 'Something' }))).toBe('tv-audio');
    expect(categorize(input({ title: 'Apple iPhone 17 256GB' }))).toBe('phones');
    expect(categorize(input({ title: 'LEGO Technic Bugatti', shopCategory: 'toys' }))).toBe('toys');
  });

  it('uses the shop category when no rule matches', () => {
    expect(categorize(input({ title: 'Corona - Case of 24', shopCategory: 'drinks' }))).toBe('drinks');
    expect(categorize(input({ categoryPath: 'Black Friday Deals', shopCategory: 'toys' }))).toBe('toys');
  });

  it('maps every shop category onto a site slug', () => {
    const expected: Record<string, string> = {
      electronics: 'other', sports: 'sports', bikes: 'sports', fashion: 'fashion', jewellery: 'fashion',
      travel: 'fashion', beauty: 'beauty-health', health: 'beauty-health', drinks: 'drinks', toys: 'toys',
      gaming: 'gaming', home: 'home-kitchen', baby: 'baby', books: 'other', music: 'other',
    };
    for (const [shopCategory, slug] of Object.entries(expected)) {
      expect(categorize(input({ shopCategory }))).toBe(slug);
    }
  });

  it('never lets a generic path segment decide the category', () => {
    for (const p of ['Black Friday Deals', 'Sale', 'Offers', 'Clearance', 'New', 'Deals > Sale']) {
      expect(categorize(input({ categoryPath: p, shopCategory: 'sports' }))).toBe('sports');
    }
    expect(categorize(input({ categoryPath: 'Black Friday Deals > Laptops' }))).toBe('laptops');
  });

  it('treats generic words as whole words only', () => {
    expect(categorize(input({ tags: ['Newborn'] }))).toBe('baby');
    expect(categorize(input({ categoryPath: 'Renewed Laptops' }))).toBe('laptops');
    expect(categorize(input({ categoryPath: 'Wholesale Laptops', shopCategory: 'sports' }))).toBe('laptops');
    expect(categorize(input({ categoryPath: 'Wholesale', title: 'Something', shopCategory: 'sports' }))).toBe('sports');
    expect(categorize(input({ categoryPath: 'New > Laptops' }))).toBe('laptops');
  });

  it('returns other when nothing matches', () => {
    expect(categorize(input())).toBe('other');
    expect(categorize(input({ categoryPath: 'Miscellaneous', title: 'Widget', shopCategory: 'unknown' }))).toBe('other');
  });

  it('lets overrides on any path segment win over the rules', () => {
    const overrides = { 'small appliances': 'appliances' };
    expect(categorize(input({ categoryPath: 'Home | Small Appliances' }), overrides)).toBe('appliances');
    expect(categorize(input({ categoryPath: 'Laptops > Small Appliances' }), overrides)).toBe('appliances');
    expect(categorize(input({ categoryPath: 'Home | Small Appliances' }))).toBe('appliances');
  });

  it('ignores overrides that point at an unknown slug', () => {
    expect(categorize(input({ categoryPath: 'Laptops' }, ), { laptops: 'nonsense' })).toBe('laptops');
  });
});
