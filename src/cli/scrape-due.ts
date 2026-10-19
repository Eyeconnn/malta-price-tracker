// pnpm scrape-due [--shop slug] [--minutes 50] [--dry-run]
// Re-reads warm and hot products whose next_check_at has passed, shop by shop in parallel.
import { parseArgs } from 'node:util';
import { closeDb } from '../db.js';
import { loadShops } from '../shops.js';
import { runDue } from '../pipeline/runDue.js';
import { closeStaleRuns, shopHasRunningRun } from '../pipeline/store.js';
import { afterAllRuns } from '../pipeline/postRun.js';
import type { RunResult } from '../pipeline/runShop.js';

const { values } = parseArgs({
  options: {
    shop: { type: 'string' },
    runner: { type: 'string' },
    minutes: { type: 'string', default: '50' },
    'dry-run': { type: 'boolean', default: false },
  },
});

async function main() {
  await closeStaleRuns();
  const shops = (await loadShops({ shop: values.shop, runner: values.runner })).filter((s) => ['shopify', 'woo', 'magento', 'html'].includes(s.adapter));
  const results: RunResult[] = [];
  await Promise.all(
    shops.map(async (shop) => {
      // never run alongside the nightly full scrape of the same shop
      if (await shopHasRunningRun(shop.id)) {
        console.log(`[${shop.slug}] full run in progress, skipping`);
        return;
      }
      try {
        const r = await runDue(shop, { dryRun: values['dry-run'], minutes: Number(values.minutes) });
        if (r) results.push(r);
      } catch (e) {
        console.error(`[${shop.slug}] ${(e as Error).message}`);
      }
    }),
  );
  console.log(`scrape-due: ${results.length} shops had due products, ${results.reduce((a, r) => a + r.totals.products_seen, 0)} re-read`);
  if (!values['dry-run']) await afterAllRuns(results, { alerts: true });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
