// pnpm export-shops: database-only shops (src/shop-requests/exportShops.ts).
import { describe, expect, it } from 'vitest';
import { addedShopsFile } from '../../src/shop-requests/exportShops.js';

const row = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  name: slug.toUpperCase(),
  base_url: `https://${slug}.example.mt`,
  category: null,
  adapter: 'shopify' as const,
  tier: 'P2' as const,
  active: true,
  config: { runner: 'local' },
  notes: null,
  ...over,
});

describe('addedShopsFile', () => {
  it('keeps only shops missing from shops.seed.json, by slug, in the seed file shape', () => {
    const file = addedShopsFile([row('zeta'), row('klikk'), row('alpha', { active: false })], new Set(['klikk']));
    expect(file.shops.map((s) => s.slug)).toEqual(['alpha', 'zeta']);
    expect(file.shops[0]).toEqual({
      slug: 'alpha',
      name: 'ALPHA',
      base_url: 'https://alpha.example.mt',
      category: null,
      adapter: 'shopify',
      tier: 'P2',
      active: false,
      config: { runner: 'local' },
      notes: null,
    });
    expect(file._comment).toMatch(/pnpm export-shops/);
  });

  it('an empty list when every shop is in the seed file', () => {
    expect(addedShopsFile([row('klikk')], new Set(['klikk'])).shops).toEqual([]);
  });
});
