// pnpm photos --runner local|cloud [--shop a,b] [--until 24:00] [--minutes N] [--chunk 500] [--concurrency 60]
//
// The daytime photo catch-up (owner decision 26 Oct 2026): downloads the product photos the nightly scrape had no
// time for, from 08:00 until --until (Malta time), on the PC for local shops (Windows task "MTP Daytime Photos")
// and on GitHub for the others (workflow photos.yml). Every request goes through the shop's own fetcher, so
// robots.txt, Crawl-delay and the shop's delays are kept; Shopify CDN photos keep the CDN fetcher's pace. A shop
// stops once it has nothing left to fetch; a shop whose scrape is running is skipped. New photos show on the site
// at once (refreshSiteImageKeys). Needs IMAGES_ENABLED=on and R2 (as the scrape does).
import { parseArgs } from 'node:util';
import { closeDb, db } from '../db.js';
import { userAgent } from '../env.js';
import { ShopFetcher } from '../http/fetcher.js';
import { catchUpShop, deadlineFor } from '../pipeline/catchUp.js';
import { downloadImagesForShop, refreshSiteImageKeys } from '../pipeline/images.js';
import { loadShops } from '../shops.js';
import type { Shop } from '../types.js';

const { values } = parseArgs({
  options: {
    shop: { type: 'string' },
    runner: { type: 'string' },
    until: { type: 'string', default: '24:00' },
    // a hard limit for this run, under the GitHub job's own timeout
    minutes: { type: 'string' },
    chunk: { type: 'string', default: '500' },
    // every shop at once: each waits only on its own host's fetcher (Shopify shops share the CDN one), and a
    // shop with nothing to fetch returns at once
    concurrency: { type: 'string', default: '60' },
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

async function main() {
  if (!values.runner && !values.shop) throw new Error('choose shops with --runner <cloud|local> or --shop <slug>');
  let until = deadlineFor(values.until, new Date());
  if (until === null) {
    console.log(`photo catch-up: ${values.until} Malta time has passed (or is not a time), nothing to do`);
    return;
  }
  if (values.minutes) until = Math.min(until, Date.now() + Number(values.minutes) * 60_000);
  const shops = await loadShops({ shop: values.shop, runner: values.runner });
  const sql = db();
  // a shop being scraped right now keeps its own photo step; its fetcher's gap must not be doubled
  const busy = new Set(
    (await sql<{ shop_id: number }[]>`select distinct shop_id from scrape_runs where finished_at is null and started_at > now() - interval '8 hours'`).map((r) => r.shop_id),
  );
  const chunk = Math.max(1, Number(values.chunk));
  console.log(`photo catch-up until ${new Date(until).toISOString()} for ${shops.length} shops (chunks of ${chunk})`);

  let total = 0;
  await pool(shops, Number(values.concurrency), async (shop: Shop) => {
    if (busy.has(shop.id)) {
      console.log(`[${shop.slug}] photo catch-up: its scrape is running, skipped`);
      return;
    }
    // one fetcher for the whole day, so chunks keep the shop's gap between them
    const shopFetcher = ShopFetcher.fromConfig(shop.config, userAgent(), shop.base_url, () => {});
    try {
      const res = await catchUpShop(shop.slug, until, chunk, {
        download: (perRun, end) => downloadImagesForShop(shop, { shopFetcher }, { perRun, until: end }),
        refresh: () => refreshSiteImageKeys(sql, shop.id),
      });
      total += res.downloaded;
    } catch (e) {
      console.error(`[${shop.slug}] photo catch-up failed: ${(e as Error).message}`);
    }
  });
  console.log(`photo catch-up finished: ${total} photos stored`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
