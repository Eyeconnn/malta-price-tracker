// pnpm site-build [--shop slug] [--skip-if-built-hours 20]
// Builds the public site's tables (site_products, verdicts history, canonical ids, shop_ratings) from the scraped prices.
// --skip-if-built-hours N: do nothing when a full build (no --shop) finished within the last N hours (backup cron).
// Only one build runs at a time (advisory lock); a second one logs and exits 0.
import { parseArgs } from 'node:util';
import type postgres from 'postgres';
import { closeDb, db } from '../db.js';
import { buildShopRatings, buildSiteProducts, lastFullBuild, markFullBuild, withBuildLock } from '../site/build.js';
import { loadSettings } from '../site/settings.js';

const { values } = parseArgs({
  options: {
    shop: { type: 'string' },
    'skip-if-built-hours': { type: 'string' },
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
    const last = await lastFullBuild(sql);
    if (last && now.getTime() - last.getTime() < hours * 3_600_000) {
      console.log(`site-build: last full build ${last.toISOString()} is within ${hours} hours, skipping`);
      return;
    }
  }

  const settings = await loadSettings(sql);
  const built = await buildSiteProducts(sql, settings, now, { shop: values.shop, log: (line) => console.log(line) });
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
