// pnpm scrape --shop atoz | --adapter shopify | --tier P1  [--limit 50] [--dry-run] [--concurrency 6] [--no-images]
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { closeDb } from '../db.js';
import { optionalEnv } from '../env.js';
import { loadShops } from '../shops.js';
import { runShop, type RunResult } from '../pipeline/runShop.js';
import { afterRun, afterAllRuns } from '../pipeline/postRun.js';
import type { AdapterName, Shop } from '../types.js';

const { values } = parseArgs({
  options: {
    shop: { type: 'string' },
    adapter: { type: 'string' },
    tier: { type: 'string' },
    runner: { type: 'string' },
    limit: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '12' },
    'no-images': { type: 'boolean', default: false },
    'no-alerts': { type: 'boolean', default: false },
    sample: { type: 'string', default: '5' },
  },
});

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (queue.length) await fn(queue.shift()!);
    }),
  );
}

function euros(c: number | null | undefined) {
  return c === null || c === undefined ? '' : (c / 100).toFixed(2);
}

function printSample(r: RunResult) {
  if (!r.sample.length) return;
  console.log(`\n${r.shop.slug}: sample of ${r.sample.length} normalised records`);
  console.table(
    r.sample.map((s) => ({
      id: s.external_id,
      title: (s.title ?? '').slice(0, 40),
      variant: (s.variant_title ?? '').slice(0, 18),
      sku: s.sku,
      gtin: s.gtin,
      mpn: s.mpn,
      price: euros(s.price_cents),
      was: euros(s.was_price_cents),
      low30: euros(s.shop_30d_low_cents),
      stock: s.in_stock,
      sale: s.on_sale,
    })),
  );
}

async function main() {
  const dryRun = values['dry-run'];
  if (!values.shop && !values.adapter && !values.tier && !values.runner) {
    throw new Error('choose shops with --shop <slug>, --adapter <name>, --tier <P1|P2|P3> or --runner <cloud|local>');
  }
  const noDb = dryRun && !optionalEnv('DATABASE_URL');
  const shops: Shop[] = await loadShops(
    { shop: values.shop, adapter: values.adapter as AdapterName | undefined, tier: values.tier, runner: values.runner },
    noDb,
  );
  if (!shops.length) {
    console.log('no matching active shops, nothing to do');
    return;
  }
  const limit = values.limit ? Number(values.limit) : undefined;
  console.log(`${dryRun ? 'DRY RUN: ' : ''}scraping ${shops.map((s) => s.slug).join(', ')}${limit ? ` (limit ${limit})` : ''}`);

  const results: RunResult[] = [];
  await pool(shops, Number(values.concurrency), async (shop) => {
    const r = await runShop(shop, { dryRun, limit, sampleSize: dryRun ? Math.max(Number(values.sample), limit ?? 0) : 0 });
    results.push(r);
    if (!dryRun) await afterRun(r, { images: !values['no-images'] && !limit });
  });

  if (dryRun) {
    for (const r of results) printSample(r);
    await mkdir('out', { recursive: true });
    const file = `out/dry-run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    await writeFile(file, JSON.stringify(results.map((r) => ({ shop: r.shop.slug, totals: r.totals, sample: r.sample })), null, 2));
    console.log(`\nfull sample written to ${file}`);
  } else {
    await afterAllRuns(results, { alerts: !values['no-alerts'] });
  }
  const failed = results.filter((r) => r.totals.status === 'failed').length;
  console.log(`\nfinished: ${results.length - failed} shops ok or partial, ${failed} failed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
