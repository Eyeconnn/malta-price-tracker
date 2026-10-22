// The curated example list and the category-alternating picker (web/src/lib/searchExamples.ts).
import { describe, expect, it } from 'vitest';
import { SITE_CATEGORIES } from '../../src/site/categories.js';
import { nextExample, SEARCH_EXAMPLES, staticExample } from '../../web/src/lib/searchExamples.js';

describe('SEARCH_EXAMPLES', () => {
  it('has 3 to 6 short examples for every site category', () => {
    for (const { slug } of SITE_CATEGORIES) {
      const list = SEARCH_EXAMPLES[slug];
      expect(list.length, slug).toBeGreaterThanOrEqual(3);
      expect(list.length, slug).toBeLessThanOrEqual(6);
      for (const text of list) {
        expect(text.length, text).toBeGreaterThan(2);
        expect(text.length, text).toBeLessThanOrEqual(24);
        expect(text, text).not.toContain('—');
      }
    }
    expect(Object.keys(SEARCH_EXAMPLES).sort()).toEqual(SITE_CATEGORIES.map((c) => c.slug).sort());
  });
});

describe('nextExample', () => {
  it('never repeats the previous category and visits every category in a cycle', () => {
    let prev = nextExample(null, Math.random);
    const seen = new Set([prev.category]);
    for (let i = 0; i < SITE_CATEGORIES.length * 3; i++) {
      const next = nextExample(prev.category, Math.random);
      expect(next.category).not.toBe(prev.category);
      expect(SEARCH_EXAMPLES[next.category]).toContain(next.text);
      seen.add(next.category);
      prev = next;
    }
    expect(seen.size).toBe(SITE_CATEGORIES.length);
  });

  it('takes the first category from the random source and a random item within it', () => {
    const first = nextExample(null, () => 0);
    expect(first.category).toBe(SITE_CATEGORIES[0]!.slug);
    expect(first.text).toBe(SEARCH_EXAMPLES[first.category][0]);
    const last = nextExample(null, () => 0.999999);
    expect(last.category).toBe(SITE_CATEGORIES.at(-1)!.slug);
    expect(last.text).toBe(SEARCH_EXAMPLES[last.category].at(-1));
  });

  it('moves on to the following category, wrapping round at the end', () => {
    const slugs = SITE_CATEGORIES.map((c) => c.slug);
    expect(nextExample(slugs[0]!, () => 0).category).toBe(slugs[1]);
    expect(nextExample(slugs.at(-1)!, () => 0).category).toBe(slugs[0]);
  });
});

describe('staticExample', () => {
  it('is one example from some category', () => {
    expect(Object.values(SEARCH_EXAMPLES).flat()).toContain(staticExample(() => 0.5));
  });
});
