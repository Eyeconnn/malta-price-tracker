// pnpm fetch-logos                 fetch the logo of every active shop that has none yet and was never checked (or
//                                  whose check failed over 30 days ago); shops with a logo are never fetched again.
// pnpm fetch-logos --shop <slug>   that shop only (an inactive shop too)
// pnpm fetch-logos --retry         look again at shops checked before that still have no logo
// pnpm fetch-logos --dry-run       fetch and report only: nothing stored in R2 or recorded (works without a database,
//                                  from shops.seed.json)
// Run by scripts/run-local.ps1 after the nightly scrape (a no-op unless a shop is new) and by pnpm shop-requests for
// a shop it has just activated. Politeness and the logo rules: src/pipeline/logos.ts (at most 4 requests per shop).
import { parseArgs } from 'node:util';
import { closeDb } from '../db.js';
import { runLogoJob } from '../pipeline/logos.js';

const { values } = parseArgs({
  options: {
    shop: { type: 'string' },
    retry: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

async function main() {
  const results = await runLogoJob({ shop: values.shop, retry: values.retry, dryRun: values['dry-run'] });
  if (!results.length) return;
  const count = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`logos: ${count('found')} found, ${count('none')} without a logo, ${count('skipped')} skipped`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
