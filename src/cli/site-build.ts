// pnpm site-build [--shop slug] [--skip-if-built-hours 20] [--name-matching]
// --name-matching (or NAME_MATCHING=on): also group listings by clean name. Off by default (owner decision 23 Oct:
// name matching waits for canonical names), so products are grouped by barcode, model number and admin confirmation.
// Builds the public site's tables (site_products, verdicts history, canonical ids, shop_ratings) from the scraped prices.
// --skip-if-built-hours N: do nothing when a full build (no --shop) ran within the last N hours and no scrape
// finished or started since it began (backup cron); a build that ran before the cloud scrapes finished is redone.
// Only one build runs at a time (advisory lock); a second one logs and exits 0.
import { parseArgs } from 'node:util';
import type postgres from 'postgres';
import { closeDb, db } from '../db.js';
import {
  buildShopRatings,
  buildSiteProducts,
  lastFullBuild,
  lastScrapeActivity,
  markFullBuild,
  shouldSkipBuild,
  withBuildLock,
} from '../site/build.js';
import { loadSettings } from '../site/settings.js';

const { values } = parseArgs({
  options: {
    shop: { type: 'string' },
    'skip-if-built-hours': { type: 'string' },
    'name-matching': { type: 'boolean' },
  },
});

async function main() {
  const sql = db();
  const started = Date.now();
  const ran = await withBuildLock(sql, () => build(sql, started));
  if (!ran) console.log('site-build: another site-build is running, exiting');
}

async function build(sql: postgres.Sql, started: number) {
  const now = new Date();

  const skipHours = values['skip-if-built-hours'];
  if (skipHours !== undefined) {
    const hours = Number(skipHours);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error(`--skip-if-built-hours needs a positive number, got ${skipHours}`);
    const [last, lastScrape] = await Promise.all([lastFullBuild(sql), lastScrapeActivity(sql)]);
    if (shouldSkipBuild({ lastBuild: last, lastScrape, now, hours })) {
      console.log(`site-build: last full build ${last?.toISOString()} is within ${hours} hours and no scrape since (last ${lastScrape?.toISOString() ?? 'none'}), skipping`);
      return;
    }
  }

  const settings = await loadSettings(sql);
  const nameMatching = values['name-matching'] === true || /^(1|on|true|yes)$/i.test(process.env.NAME_MATCHING ?? '');
  console.log(`site-build: name matching ${nameMatching ? 'on' : 'off'}`);
  const built = await buildSiteProducts(sql, settings, now, { shop: values.shop, log: (line) => console.log(line), nameMatching });
  const rated = await buildShopRatings(sql, settings, now);
  // only a full build counts for --skip-if-built-hours; a failure above never gets here
  if (values.shop === undefined) await markFullBuild(sql, now);

  const verdicts = await sql`select verdict, count(*)::int as n from site_products group by verdict order by verdict`;
  const methods = await sql`select coalesce(match_method, 'unmatched') as method, count(*)::int as n from site_products group by 1 order by 1`;
  const grades = await sql`select coalesce(grade, 'not rated') as grade, count(*)::int as n from shop_ratings group by 1 order by 1`;
  const fmt = (rows: postgres.Row[], k: string) => rows.map((r) => `${r[k]} ${r.n}`).join(', ');
  console.log(`site-build: ${built.products} groups built, ${built.judged} judged, ${rated} shops rated`);
  console.log(`verdicts: ${fmt(verdicts, 'verdict')}`);
  console.log(`matches: ${fmt(methods, 'method')}`);
  console.log(`ratings: ${fmt(grades, 'grade')}`);
  console.log(`site-build: done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
