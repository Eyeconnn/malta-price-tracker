import { readFile } from 'node:fs/promises';
import { db } from './db.js';
import type { UnavailableReason } from './shop-requests/reasons.js';
import type { AdapterName, Shop } from './types.js';

export interface ShopFilter {
  shop?: string;
  adapter?: AdapterName;
  tier?: string;
  /** 'cloud' (GitHub Actions) or 'local'; shops default to cloud */
  runner?: string;
  includeInactive?: boolean;
}

export interface SeedFile {
  do_not_scrape: string[];
  /** unavailable_reason: why a switched-off shop is off, as visitors are told (src/shop-requests/reasons.ts) */
  shops: (Omit<Shop, 'id'> & { notes?: string | null; unavailable_reason?: UnavailableReason | null })[];
}

export async function readSeed(): Promise<SeedFile> {
  return JSON.parse(await readFile('shops.seed.json', 'utf8')) as SeedFile;
}

function matches(s: Omit<Shop, 'id'>, f: ShopFilter): boolean {
  // --shop accepts one slug or a comma separated list
  if (f.shop && !f.shop.split(',').map((x) => x.trim()).includes(s.slug)) return false;
  if (f.adapter && s.adapter !== f.adapter) return false;
  if (f.tier && s.tier !== f.tier) return false;
  if (f.runner) {
    const r = s.config?.runner ?? 'cloud';
    if (r !== 'cloud' && r !== 'local') throw new Error(`shop ${s.slug}: unknown config.runner "${String(r)}"`);
    if (r !== f.runner) return false;
  }
  // a shop named explicitly runs even when inactive (manual testing)
  if (!f.shop && !f.includeInactive && !s.active) return false;
  return true;
}

/** Shops from the database, or from shops.seed.json when there is no database (dry runs). */
export async function loadShops(f: ShopFilter, fromSeed = false): Promise<Shop[]> {
  if (f.runner && f.runner !== 'cloud' && f.runner !== 'local') throw new Error(`--runner must be cloud or local`);
  if (fromSeed) {
    const seed = await readSeed();
    return seed.shops.filter((s) => matches(s, f)).map((s, i) => ({ ...s, id: -(i + 1), config: s.config ?? {} }));
  }
  const rows = await db()<Shop[]>`select id, slug, name, base_url, category, adapter, config, tier, active from shops order by slug`;
  return rows.filter((s) => matches(s, f));
}
