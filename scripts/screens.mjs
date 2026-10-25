// Screenshots of every public page for the design check (and an optional axe run), against `pnpm web:dev`.
//
//   node scripts/screens.mjs [--only=home,product] [--axe] [--base=http://127.0.0.1:5173]
//
// Writes out/redesign-screens/<page>-<desktop|phone>-<light|dark>-<simple|advanced>.png, and with --axe
// out/redesign-screens/axe.json. The site password is read from web/.dev.vars and never printed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const BASE = args.base ?? 'http://127.0.0.1:5173';
const OUT = 'out/redesign-screens';
mkdirSync(OUT, { recursive: true });

function devVar(name) {
  try {
    const line = readFileSync('web/.dev.vars', 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).replace(/^"|"$/g, '') : null;
  } catch {
    return null;
  }
}
const password = devVar('SITE_PASSWORD');
const httpCredentials = password ? { username: 'guide', password } : undefined;

const browser = await chromium.launch();

// pick a real shop and product from the API
const probe = await browser.newContext({ httpCredentials });
const shops = await (await probe.request.get(`${BASE}/api/shops`)).json();
const shopSlug = args.shop ?? shops.shops?.find((s) => s.grade)?.slug ?? shops.shops?.[0]?.slug;
const found = await (await probe.request.get(`${BASE}/api/search?q=${encodeURIComponent(args.q ?? 'iphone 17 pro')}`)).json();
const productKey = args.product ?? found.results?.find((r) => r.shops > 1)?.key ?? found.results?.[0]?.key;
await probe.close();

const PAGES = {
  home: '/',
  deals: '/deals',
  shops: '/shops',
  shop: shopSlug ? `/shops/${encodeURIComponent(shopSlug)}` : null,
  product: productKey ? `/product/${productKey}` : null,
  search: '/search?q=lego',
  how: '/how-we-check',
  notfound: '/no-such-page',
};
// Sample judged deals for the pages whose real lists are still empty (no product has 14 days of prices yet).
// Used only in the browser for these screenshots, never stored.
const card = (id, title, shop, slug, price, was, verdict, extra = {}) => ({
  id, title, shop, shopSlug: slug, priceCents: price, wasCents: was, verdict, bf: true, category: null,
  raisedFrom: null, wasRaisedFromCents: null, logoUrl: null, logoAspect: null,
  reason: verdict === 'good' ? `€40.00 below its lowest price in the 24 days before 16 Nov (€${(was / 100).toFixed(2)}).` : 'Price went from €399.00 on 7 Nov to €429.00 on 12 Nov while marked Black Friday.',
  ...extra,
});
const GOOD = [
  card(9001, 'Sony WH-1000XM6 Wireless Noise Cancelling Headphones', 'Pixel Point', shopSlug, 35900, 39900, 'good'),
  card(9002, 'Apple AirPods Pro 3', 'Harbour Tech', shopSlug, 22900, 27900, 'good'),
  card(9003, 'Samsung 55" QLED Q80F 4K TV', 'Isla Digital', shopSlug, 74900, 89900, 'good'),
  card(9004, 'Dyson V15 Detect Absolute', 'Casa Living', shopSlug, 54900, 69900, 'good', { bf: false }),
  card(9005, 'LEGO Technic 4x4 Off-Roader', 'Toy Cove', shopSlug, 11900, 14900, 'good'),
  card(9006, 'Nintendo Switch 2', 'Byte Arcade', shopSlug, 43900, 47900, 'good'),
];
const AVOID = [
  card(9101, 'Sony WH-1000XM6 Wireless Noise Cancelling Headphones', 'Volt Electronics', shopSlug, 42900, 49900, 'avoid', { raisedFrom: { priceCents: 39900, at: '2026-11-07' } }),
  card(9102, 'iPhone 17 128GB', 'Isla Digital', shopSlug, 92900, 109900, 'avoid', { reason: 'Was price €1,099.00 is higher than any price charged since 23 Oct (highest €949.00).' }),
  card(9103, 'PlayStation 5 Slim Digital', 'Harbour Tech', shopSlug, 44900, 54900, 'avoid', { wasRaisedFromCents: 49900, reason: 'Was price went from €499.00 on 8 Nov to €549.00 on 14 Nov while the price stayed at €449.00.' }),
  card(9104, 'Nike Air Max 90', 'Trend Wardrobe', shopSlug, 13900, 17900, 'avoid', { raisedFrom: { priceCents: 11900, at: '2026-11-07' } }),
];
async function withSamples(page) {
  if (!args.samples) return;
  await page.route('**/api/home', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (!body.good?.length && !body.avoid?.length) Object.assign(body, { good: GOOD, avoid: AVOID });
    await route.fulfill({ response: res, json: body });
  });
  await page.route('**/api/deals?*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (!body.items?.length) {
      const type = new URL(route.request().url()).searchParams.get('type');
      body.items = type === 'avoid' ? AVOID : GOOD;
      body.total = body.items.length;
    }
    await route.fulfill({ response: res, json: body });
  });
  await page.route('**/api/shops/*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (body.shop && !body.good?.length && !body.avoid?.length) Object.assign(body, { good: GOOD.slice(0, 2), avoid: AVOID.slice(0, 3) });
    await route.fulfill({ response: res, json: body });
  });
}

const only = typeof args.only === 'string' ? args.only.split(',') : null;
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const axe = [];

for (const [name, path] of Object.entries(PAGES)) {
  if (!path || (only && !only.includes(name))) continue;
  for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark']) {
      for (const mode of ['simple', 'advanced']) {
        const ctx = await browser.newContext({
          viewport,
          httpCredentials,
          colorScheme: theme,
          isMobile: vp === 'phone',
          hasTouch: vp === 'phone',
          deviceScaleFactor: 1,
        });
        await ctx.addInitScript(([t, m]) => {
          try {
            localStorage.setItem('theme', t);
            localStorage.setItem('mode', m);
          } catch {}
        }, [theme, mode]);
        const page = await ctx.newPage();
        await withSamples(page);
        await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1600); // entry animations, chart draw
        await page.screenshot({ path: `${OUT}/${name}-${vp}-${theme}-${mode}.png`, fullPage: true });
        if (args.axe && mode === 'simple') {
          const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
          axe.push({
            page: name,
            vp,
            theme,
            violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) })),
          });
        }
        await ctx.close();
      }
    }
  }
  console.log(`shot ${name}`);
}
if (args.axe) {
  writeFileSync(`${OUT}/axe.json`, JSON.stringify(axe, null, 2));
  const total = axe.reduce((n, r) => n + r.violations.length, 0);
  console.log(`axe: ${total} violation groups`);
  for (const r of axe) for (const v of r.violations) console.log(`  ${r.page} ${r.vp} ${r.theme}: ${v.id} (${v.impact}) ${v.nodes[0] ?? ''}`);
}
await browser.close();
