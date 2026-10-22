// Runs every read-API query in web/worker/data.ts once against Neon with the read-only role
// (DASHBOARD_DATABASE_URL from .env) and prints row counts and timings only. Exit code 1 when a query
// fails or takes 1.5 s or more.   pnpm exec tsx scripts/web-smoke.ts
import { neon } from '@neondatabase/serverless';
import { neonData } from '../web/worker/data.js';

process.loadEnvFile('.env');
const url = process.env.DASHBOARD_DATABASE_URL;
if (!url) throw new Error('DASHBOARD_DATABASE_URL is not set');

const LIMIT_MS = 1500;
const data = neonData(url);
let failed = false;

async function timed<T>(name: string, run: () => Promise<T>, count: (r: T) => string): Promise<T | null> {
  const t0 = performance.now();
  try {
    const r = await run();
    const ms = Math.round(performance.now() - t0);
    const slow = ms >= LIMIT_MS;
    if (slow) failed = true;
    console.log(`${slow ? 'SLOW' : 'ok  '} ${name.padEnd(34)} ${String(ms).padStart(5)} ms  ${count(r)}`);
    return r;
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name.padEnd(34)} ${(e as Error).message}`);
    return null;
  }
}

// warm the compute so the first timing is not a cold start
await data.settings().catch(() => undefined);

await timed('settings', () => data.settings(), (s) => `phrases ${Object.values(s.phrases).flat().length}, cheaperPct ${s.thresholds.cheaperPct}`);
await timed('deals good p1', () => data.deals({ verdict: 'good', category: null, shop: null, limit: 24, offset: 0 }), (r) => `items ${r.items.length}, total ${r.total}`);
await timed('deals avoid p1', () => data.deals({ verdict: 'avoid', category: null, shop: null, limit: 24, offset: 0 }), (r) => `items ${r.items.length}, total ${r.total}`);
await timed('deals good laptops p3', () => data.deals({ verdict: 'good', category: 'laptops', shop: null, limit: 24, offset: 48 }), (r) => `items ${r.items.length}, total ${r.total}`);
const shops = await timed('shops', () => data.shops(), (r) => `shops ${r.length}, products ${r.reduce((n, s) => n + s.products, 0)}`);
const biggest = shops?.slice().sort((a, b) => b.products - a.products)[0];
const shop = biggest ? await timed(`shop (largest)`, () => data.shop(biggest.slug), (r) => (r ? `products ${r.stats.products}, judged ${r.stats.judged}` : 'not found')) : null;
await timed('deals avoid (largest shop)', () => data.deals({ verdict: 'avoid', category: null, shop: biggest?.slug ?? null, limit: 5, offset: 0 }), (r) => `items ${r.items.length}, total ${r.total}`);
if (shop) await timed('shopChanges (largest)', () => data.shopChanges(shop.shop.id), (r) => `rises ${r.rises.length}, drops ${r.drops.length}`);
for (const q of ['samsung galaxy', 'iphone', 'lego', '%%%']) {
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  await timed(`search "${q}"`, () => data.search({ text: q, like }, null), (r) => `rows ${r.length}, groups ${new Set(r.map((h) => h.groupKey)).size}`);
}
const hits = await timed('search "iphone" in largest shop', () => data.search({ text: 'iphone', like: '%iphone%' }, biggest?.slug ?? null), (r) => `rows ${r.length}`);
const anyHits = (await data.search({ text: 'samsung galaxy', like: '%samsung galaxy%' }, null)) ?? [];
const matched = anyHits.find((h) => h.canonicalId !== null) ?? anyHits[0] ?? hits?.[0];
if (matched) {
  await timed('product (matched)', () => data.product(matched.id), (r) => (r ? `variants ${r.variants.length}, history ${r.history.length}, others ${r.others.length}` : 'not found'));
}
// worst case for variants and history: the fresh group with the most variants
const [widest] = (await neon(url)`
  select id from site_products where updated_at > now() - interval '2 days' order by variant_count desc, id limit 1`) as { id: string }[];
if (widest) {
  await timed('product (most variants)', () => data.product(Number(widest.id)), (r) => (r ? `variants ${r.variants.length}, history ${r.history.length}, others ${r.others.length}` : 'not found'));
}
await timed('product (unknown id)', () => data.product(2_000_000_000), (r) => (r ? 'found' : 'null'));
await timed('categories', () => data.categories(), (r) => `categories ${r.length}, products ${r.reduce((n, c) => n + c.count, 0)}`);

process.exitCode = failed ? 1 : 0;
