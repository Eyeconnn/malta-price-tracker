// Shops that live only in the database (added from the admin area), in the shape of shops.seed.json,
// for pnpm export-shops. pnpm seed never deletes them; this file lets them be committed if wanted.
import type { SeedFile } from '../shops.js';

export type SeedShop = SeedFile['shops'][number];

export interface AddedShopsFile {
  _comment: string;
  shops: SeedShop[];
}

export function addedShopsFile(dbShops: SeedShop[], seedSlugs: Set<string>): AddedShopsFile {
  const shops = dbShops
    .filter((s) => !seedSlugs.has(s.slug))
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((s) => ({
      slug: s.slug,
      name: s.name,
      base_url: s.base_url,
      category: s.category,
      adapter: s.adapter,
      tier: s.tier,
      active: s.active,
      config: s.config ?? {},
      notes: s.notes ?? null,
    }));
  return {
    _comment: 'Shops in the database but not in shops.seed.json (added from the admin area). Written by pnpm export-shops; same shape as shops.seed.json.',
    shops,
  };
}
