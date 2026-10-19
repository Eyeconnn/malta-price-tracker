// pnpm snapshot <url> [--shop slug] [--dry-run]
import { parseArgs } from 'node:util';
import { closeDb } from '../db.js';
import { optionalEnv } from '../env.js';
import { loadShops } from '../shops.js';
import { snapshotUrl } from '../pipeline/snapshot.js';

const { values, positionals } = parseArgs({
  options: { shop: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  allowPositionals: true,
});

async function main() {
  if (!positionals.length) throw new Error('usage: pnpm snapshot <url> [more urls] [--shop slug] [--dry-run]');
  const noDb = !optionalEnv('DATABASE_URL');
  const shop = values.shop ? (await loadShops({ shop: values.shop }, noDb))[0] : undefined;
  for (const url of positionals) await snapshotUrl(url, shop, values['dry-run'] || noDb);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
