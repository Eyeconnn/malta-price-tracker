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
