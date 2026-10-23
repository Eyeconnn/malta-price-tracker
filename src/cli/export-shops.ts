// pnpm export-shops: writes the shops that exist only in the database (added from the admin area, not in
// shops.seed.json) to shops.added.json, in the seed file's shape, so they can be committed if wanted.
import { writeFile } from 'node:fs/promises';
import { closeDb, db } from '../db.js';
import { readSeed } from '../shops.js';
import { type SeedShop, addedShopsFile } from '../shop-requests/exportShops.js';

async function main() {
  const rows = await db()<SeedShop[]>`select slug, name, base_url, category, adapter, tier, active, config, notes from shops order by slug`;
  const seed = await readSeed();
  const file = addedShopsFile(rows, new Set(seed.shops.map((s) => s.slug)));
  await writeFile('shops.added.json', `${JSON.stringify(file, null, 2)}\n`);
  console.log(`${file.shops.length} database-only shop(s) written to shops.added.json`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
