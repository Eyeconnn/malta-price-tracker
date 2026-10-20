// Single-page dashboard. Plain HTML/CSS/JS, no build step. All shop-supplied text goes through esc().
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Price Tracker</title>
<style>
  :root {
    --bg: #f6f5f1; --panel: #ffffff; --ink: #1d1d1b; --muted: #6b6a65; --line: #e3e1da;
    --accent: #1f5f8b; --good: #1d7a46; --bad: #b3261e; --warn: #9a6700; --chip: #efede6;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151514; --panel: #1e1e1c; --ink: #ecebe6; --muted: #a09e96; --line: #33322f;
      --accent: #7fb6dd; --good: #6fcf97; --bad: #f28b82; --warn: #e2b340; --chip: #2a2a27; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding: 18px 20px 6px; display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: baseline; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
  .totals { color: var(--muted); font-size: 13px; }
  nav { display: flex; gap: 4px; padding: 0 16px; border-bottom: 1px solid var(--line); }
  nav button { background: none; border: 0; padding: 10px 14px; font: inherit; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; }
  nav button.on { color: var(--ink); border-color: var(--accent); }
  main { padding: 16px 20px 60px; max-width: 1200px; }
  input, select { font: inherit; padding: 9px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); }
  #q { width: min(560px, 100%); font-size: 16px; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
  .muted { color: var(--muted); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; }
  .card h3 { margin: 0 0 2px; font-size: 15px; }
  .ids { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  th, td { padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .best td { background: color-mix(in srgb, var(--good) 12%, transparent); }
  .up { color: var(--bad); } .down { color: var(--good); }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 99px; background: var(--chip); font-size: 12px; }
  .ok { color: var(--good); } .partial { color: var(--warn); } .failed { color: var(--bad); }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  .link { cursor: pointer; color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  .stat b { display: block; font-size: 20px; }
  .scroll { overflow-x: auto; }
  dialog { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--ink); width: min(760px, 94vw); padding: 18px; }
  dialog::backdrop { background: rgba(0,0,0,.35); }
  svg.chart { width: 100%; height: 180px; display: block; margin: 8px 0 12px; }
  .note { font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Price Tracker</h1>
  <span class="totals" id="totals">loading...</span>
</header>
<nav>
  <button data-tab="search" class="on">Compare products</button>
  <button data-tab="shops">Shops</button>
</nav>
<main>
  <section id="tab-search">
    <div class="bar">
      <input id="q" placeholder="Search products across all shops, e.g. iphone 17 256gb" autocomplete="off" autofocus>
      <select id="qshop"><option value="">All shops</option></select>
      <span class="muted" id="qinfo"></span>
    </div>
    <div id="results"><p class="note">Type at least two characters. Results group the same product across shops (by barcode, part number or title) with the cheapest first.</p></div>
  </section>
  <section id="tab-shops" hidden>
    <div id="shopview"></div>
  </section>
</main>
<dialog id="dlg"><div id="dlgbody"></div><p><button data-close>Close</button></p></dialog>
<script nonce="__NONCE__">
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\\/\\//i.test(u || '') ? esc(u) : '#');
const eur = (c) => (c === null || c === undefined ? '' : '\\u20ac' + (c / 100).toLocaleString('en-MT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const when = (t) => (t ? new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const api = async (path) => { const r = await fetch(new URL(path, location.origin)); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); };

document.querySelectorAll('nav button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
  $('#tab-search').hidden = b.dataset.tab !== 'search';
  $('#tab-shops').hidden = b.dataset.tab !== 'shops';
  if (b.dataset.tab === 'shops' && !$('#shopview').dataset.loaded) showShops();
});

let SHOPS = [];
async function loadShops() {
  const d = await api('/api/shops');
  SHOPS = d.shops;
  const t = d.totals;
  $('#totals').textContent = Number(t.products).toLocaleString('en') + ' products, ' + Number(t.prices_24h).toLocaleString('en') +
    ' prices in the last 24 h, database ' + Math.round(Number(t.db_bytes) / 1e6) + ' MB';
  $('#qshop').innerHTML = '<option value="">All shops</option>' + SHOPS.map((s) => '<option value="' + esc(s.slug) + '">' + esc(s.name) + '</option>').join('');
}

// ---------- search ----------
let timer, seq = 0;
$('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
$('#qshop').addEventListener('change', search);

// Grouping "the same product" across shops: same barcode or part number, else similar titles.
// Colours and filler words are ignored; numbers and model words (pro, max, mini...) must agree.
const IGNORE = new Set(('black white silver grey gray blue red green pink purple gold yellow orange beige brown navy titanium natural desert dessert ' +
  'midnight starlight graphite space sage mist lavender cream rose violet teal mint coral obsidian porcelain ' +
  'smartphone phone mobile storage with and the for new edition version dual sim unlocked eu uk ver colour color').split(' '));
const MODEL = new Set('pro max plus mini ultra air lite se fe neo slim xl xs'.split(' '));
function tokens(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !IGNORE.has(w));
}
function sameProduct(a, b) {
  const da = a.filter((w) => /[0-9]/.test(w)), db = b.filter((w) => /[0-9]/.test(w));
  const [small, big] = da.length <= db.length ? [da, db] : [db, da];
  if (!small.every((w) => big.includes(w))) return false;
  const ma = a.filter((w) => MODEL.has(w)).sort().join(' '), mb = b.filter((w) => MODEL.has(w)).sort().join(' ');
  if (ma !== mb) return false;
  const sa = new Set(a), sb = new Set(b);
  let inter = 0; for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.5;
}

async function search() {
  const q = $('#q').value.trim();
  const my = ++seq;
  if (q.length < 2) { $('#results').innerHTML = ''; $('#qinfo').textContent = ''; return; }
  $('#qinfo').textContent = 'searching...';
  const shop = $('#qshop').value;
  let d;
  try { d = await api('/api/search?q=' + encodeURIComponent(q) + (shop ? '&shop=' + encodeURIComponent(shop) : '')); }
  catch (e) { $('#qinfo').textContent = 'error: ' + e.message; return; }
  if (my !== seq) return;
  const groups = [];
  for (const r of d.results) {
    const tk = tokens(r.title);
    const mpn = r.mpn && r.mpn.length >= 5 ? r.mpn.toLowerCase().replace(/[^a-z0-9]/g, '') : null;
    let g = groups.find((x) => (r.gtin && x.gtins.has(r.gtin)) || (mpn && x.mpns.has(mpn)) || sameProduct(x.tokens, tk));
    if (!g) { g = { title: r.title, brand: r.brand, gtin: r.gtin, mpn: r.mpn, score: r.score, tokens: tk, gtins: new Set(), mpns: new Set(), byShop: new Map() }; groups.push(g); }
    if (r.gtin) g.gtins.add(r.gtin);
    if (mpn) g.mpns.add(mpn);
    // per shop keep the cheapest variant and count the variants
    const cur = g.byShop.get(r.slug);
    if (!cur) g.byShop.set(r.slug, { ...r, variants: 1 });
    else { cur.variants++; if ((r.price_cents ?? 1e12) < (cur.price_cents ?? 1e12)) g.byShop.set(r.slug, { ...r, variants: cur.variants }); }
  }
  const list = groups.sort((a, b) => (b.byShop.size - a.byShop.size) || (b.score - a.score)).slice(0, 40);
  $('#qinfo').textContent = d.results.length + ' matches in ' + list.length + ' groups';
  $('#results').innerHTML = list.map(renderGroup).join('') || '<p class="note">No matches.</p>';
}

function renderGroup(g) {
  const rows = [...g.byShop.values()].sort((a, b) => (a.price_cents ?? 1e12) - (b.price_cents ?? 1e12));
  const best = rows[0]?.price_cents;
  const ids = [g.brand, g.gtin && 'EAN ' + g.gtin, g.mpn && 'MPN ' + g.mpn].filter(Boolean).map(esc).join(' &middot; ');
  return '<div class="card"><h3>' + esc(g.title) + '</h3><div class="ids">' + (ids || '&nbsp;') +
    (rows.length > 1 ? ' <span class="chip">' + rows.length + ' shops</span>' : '') + '</div><div class="scroll"><table><tr><th>Shop</th><th class="num">Price</th><th class="num">Was</th><th class="num">30-day low</th><th>Stock</th><th></th></tr>' +
    rows.map((r) => '<tr class="' + (rows.length > 1 && r.price_cents === best ? 'best' : '') + '"><td>' + esc(r.shop) +
      (r.variants > 1 ? ' <span class="chip">' + r.variants + ' variants, from</span>' : '') + (r.variant_title ? '<div class="muted">' + esc(r.variant_title) + '</div>' : '') +
      '</td><td class="num">' + eur(r.price_cents) + '</td><td class="num muted">' + eur(r.was_price_cents) + '</td><td class="num">' + eur(r.low_30d_cents) +
      '</td><td>' + (r.in_stock === false ? '<span class="muted">out</span>' : r.in_stock ? 'in' : '') +
      '</td><td><span class="link" data-product="' + Number(r.id) + '">history</span> &middot; <a href="' + safeUrl(r.url) + '" target="_blank" rel="noopener noreferrer">shop</a></td></tr>').join('') +
    '</table></div></div>';
}

// ---------- shops ----------
function showShops() {
  const v = $('#shopview');
  v.dataset.loaded = '1';
  v.innerHTML = '<div class="scroll"><table><tr><th>Shop</th><th>Category</th><th>Runs on</th><th>Last run</th><th class="num">Products</th><th>Status</th></tr>' +
    SHOPS.map((s) => '<tr><td><span class="link" data-shop="' + esc(s.slug) + '">' + esc(s.name) + '</span></td><td>' + esc(s.category) +
      '</td><td>' + esc(s.runner === 'local' ? 'this PC' : 'GitHub') + '</td><td>' + when(s.started_at) + '</td><td class="num">' + (s.products_seen ?? '') +
      '</td><td class="' + esc(s.status || '') + '">' + esc(s.status || (s.started_at ? 'running' : 'no run yet')) + '</td></tr>').join('') + '</table></div>';
}

async function showShop(slug) {
  const v = $('#shopview');
  v.innerHTML = '<p class="muted">loading...</p>';
  const d = await api('/api/shop/' + encodeURIComponent(slug));
  const s = d.stats, last = d.runs[0];
  const pct = (x) => (x > 0 ? '<span class="up">+' + x + '%</span>' : '<span class="down">' + x + '%</span>');
  v.innerHTML = '<p><span class="link" data-allshops>&larr; all shops</span></p><h2 style="margin:4px 0 2px">' + esc(d.shop.name) + '</h2>' +
    '<p class="note"><a href="' + safeUrl(d.shop.base_url) + '" target="_blank" rel="noopener noreferrer">' + esc(d.shop.base_url) + '</a> &middot; ' + esc(d.shop.adapter) + ' &middot; ' + esc(d.shop.notes || '') + '</p>' +
    '<div class="grid"><div class="stat"><span class="muted">Products</span><b>' + s.products.toLocaleString('en') + '</b></div>' +
    '<div class="stat"><span class="muted">Listed now</span><b>' + s.listed_now.toLocaleString('en') + '</b></div>' +
    '<div class="stat"><span class="muted">Warm / hot</span><b>' + s.warm + ' / ' + s.hot + '</b></div>' +
    '<div class="stat"><span class="muted">Last run</span><b class="' + esc(last?.status || '') + '">' + esc(last?.status || 'none') + '</b><span class="muted">' + when(last?.started_at) + '</span></div></div>' +
    '<h3>Top price changes (latest vs previous check)</h3>' +
    (d.changes.length ? '<div class="scroll"><table><tr><th>Product</th><th class="num">Before</th><th class="num">Now</th><th class="num">Change</th><th>When</th></tr>' +
      d.changes.map((c) => '<tr><td><span class="link" data-product="' + Number(c.id) + '">' + esc(c.title) + '</span>' + (c.variant_title ? ' <span class="muted">' + esc(c.variant_title) + '</span>' : '') +
        '</td><td class="num">' + eur(c.prev_cents) + '</td><td class="num">' + eur(c.now_cents) + '</td><td class="num">' + pct(c.pct) + '</td><td>' + when(c.observed_at) + '</td></tr>').join('') + '</table></div>'
      : '<p class="note">No price changes yet. Changes appear once a product has been checked at least twice.</p>') +
    '<h3>Biggest claimed discounts now</h3>' +
    (d.discounts.length ? '<div class="scroll"><table><tr><th>Product</th><th class="num">Was</th><th class="num">Now</th><th class="num">Claimed</th><th class="num">30-day low</th></tr>' +
      d.discounts.map((c) => '<tr><td><span class="link" data-product="' + Number(c.id) + '">' + esc(c.title) + '</span>' + (c.variant_title ? ' <span class="muted">' + esc(c.variant_title) + '</span>' : '') +
        '</td><td class="num muted">' + eur(c.was_price_cents) + '</td><td class="num">' + eur(c.now_cents) + '</td><td class="num">-' + c.claimed_pct + '%</td><td class="num">' + eur(c.low_30d_cents) + '</td></tr>').join('') + '</table></div>'
      : '<p class="note">No products shown with a was price.</p>') +
    '<h3>Recent runs</h3><div class="scroll"><table><tr><th>Started</th><th>Kind</th><th>Status</th><th class="num">Products</th><th class="num">Requests</th><th>Notes</th></tr>' +
    d.runs.map((r) => '<tr><td>' + when(r.started_at) + '</td><td>' + esc(r.kind) + '</td><td class="' + esc(r.status || '') + '">' + esc(r.status || 'running') + '</td><td class="num">' + r.products_seen +
      '</td><td class="num">' + r.requests + (r.failed_requests ? ' (' + r.failed_requests + ' failed)' : '') + '</td><td class="muted">' + esc((r.notes || '').slice(0, 160)) + '</td></tr>').join('') + '</table></div>';
}

// ---------- product ----------
async function showProduct(id) {
  const d = await api('/api/product/' + Number(id));
  const p = d.product, h = d.history.filter((x) => x.price_cents > 0);
  let chart = '<p class="note">Only one observation so far.</p>';
  if (h.length > 1) {
    const xs = h.map((x) => new Date(x.observed_at).getTime()), ys = h.map((x) => x.price_cents);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys) * 0.97, y1 = Math.max(...ys) * 1.03;
    const W = 700, H = 170, X = (x) => 40 + (W - 50) * (x - x0) / Math.max(1, x1 - x0), Y = (y) => H - 20 - (H - 30) * (y - y0) / Math.max(1, y1 - y0);
    const pts = h.map((x, i) => X(xs[i]).toFixed(1) + ',' + Y(ys[i]).toFixed(1)).join(' ');
    chart = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="price history"><polyline fill="none" stroke="currentColor" stroke-width="2" points="' + pts + '" style="color:var(--accent)"/>' +
      '<text x="0" y="' + (Y(Math.max(...ys)) + 4) + '" font-size="11" fill="currentColor">' + eur(Math.max(...ys)) + '</text><text x="0" y="' + (Y(Math.min(...ys)) + 4) + '" font-size="11" fill="currentColor">' + eur(Math.min(...ys)) + '</text></svg>';
  }
  $('#dlgbody').innerHTML = '<h3 style="margin-top:0">' + esc(p.title) + (p.variant_title ? ' <span class="muted">' + esc(p.variant_title) + '</span>' : '') + '</h3>' +
    '<p class="note">' + esc(p.shop) + ' &middot; ' + [p.brand, p.sku && 'SKU ' + p.sku, p.gtin && 'EAN ' + p.gtin, p.mpn && 'MPN ' + p.mpn].filter(Boolean).map(esc).join(' &middot; ') +
    ' &middot; tier ' + esc(p.watch_tier) + ' &middot; <a href="' + safeUrl(p.url) + '" target="_blank" rel="noopener noreferrer">open in shop</a></p>' + chart +
    '<div class="scroll"><table><tr><th>When</th><th class="num">Price</th><th class="num">Was</th><th>Stock</th><th>Flag</th></tr>' +
    d.history.slice().reverse().map((x) => '<tr><td>' + when(x.observed_at) + '</td><td class="num">' + eur(x.price_cents) + '</td><td class="num muted">' + eur(x.was_price_cents) +
      '</td><td>' + (x.in_stock === false ? 'out' : x.in_stock ? 'in' : '') + '</td><td class="failed">' + esc(x.review_flag || '') + '</td></tr>').join('') + '</table></div>';
  $('#dlg').showModal();
}

// One delegated click handler: values come from data-* attributes, never from generated code.
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-product],[data-shop],[data-allshops],[data-close]');
  if (!t) return;
  if (t.dataset.product) showProduct(Number(t.dataset.product));
  else if (t.dataset.shop && /^[a-z0-9-]+$/.test(t.dataset.shop)) showShop(t.dataset.shop);
  else if ('allshops' in t.dataset) showShops();
  else if ('close' in t.dataset) $('#dlg').close();
});

loadShops().catch((e) => { $('#totals').textContent = 'error: ' + e.message; });
</script>
</body>
</html>`;
