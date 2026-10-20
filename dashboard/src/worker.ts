// Private dashboard for the Malta price tracker: Cloudflare Worker + Neon (read-only role).
// Routes: /            the page
//         /api/shops   shops with their latest run
//         /api/search  ?q=  fuzzy title search across shops (pg_trgm word similarity)
//         /api/shop/:slug   stats, recent runs, top price changes, biggest claimed discounts
//         /api/product/:id  product with 60 days of price history
import { neon } from '@neondatabase/serverless';
import { PAGE } from './page.js';

interface Env {
  DATABASE_URL: string; // read-only role (dashboard_ro)
  DASHBOARD_PASSWORD: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** HTTP Basic auth; any user name, the password must match DASHBOARD_PASSWORD. Compares SHA-256 digests. */
async function authorised(req: Request, env: Env): Promise<boolean> {
  const h = req.headers.get('authorization') ?? '';
  if (!h.startsWith('Basic ') || !env.DASHBOARD_PASSWORD) return false;
  let decoded = '';
  try {
    decoded = atob(h.slice(6));
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(decoded.slice(sep + 1))),
    crypto.subtle.digest('SHA-256', enc.encode(env.DASHBOARD_PASSWORD)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!(await authorised(req, env))) {
      // slow down password guessing
      await new Promise((r) => setTimeout(r, 750));
      return new Response('Login required', {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="Price tracker", charset="UTF-8"', ...SECURITY_HEADERS },
      });
    }
    const url = new URL(req.url);
    let res: Response;
    try {
      res = await route(url, env);
    } catch (e) {
      console.error('dashboard error', url.pathname, (e as Error).message);
      res = json({ error: 'internal error' }, 500);
    }
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  },
};

async function route(url: URL, env: Env): Promise<Response> {
  const sql = neon(env.DATABASE_URL);
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    return new Response(PAGE.replace('__NONCE__', nonce), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; ` +
          "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      },
    });
  }

  if (p === '/api/shops') {
    const rows = await sql`
      select s.slug, s.name, s.adapter, s.tier, s.category, s.active,
        coalesce((s.config->>'runner'), 'cloud') as runner,
        r.status, r.products_seen, r.started_at, r.finished_at, r.notes
      from shops s
      left join lateral (
        select * from scrape_runs r where r.shop_id = s.id and r.kind = 'full'
        order by r.started_at desc limit 1
      ) r on true
      where s.active
      order by s.name`;
    const [totals] = await sql`
      select (select count(*) from products)::int as products,
             (select count(*) from price_observations where observed_at > now() - interval '26 hours')::int as prices_24h,
             (select pg_database_size(current_database()))::bigint as db_bytes`;
    return json({ shops: rows, totals });
  }

  if (p === '/api/search') {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 120);
    if (q.length < 2) return json({ results: [] });
    const shop = url.searchParams.get('shop');
    const [, rows] = await sql.transaction([
      sql`select set_config('pg_trgm.word_similarity_threshold', '0.5', true)`,
      sql`
        select p.id, p.title, p.variant_title, p.brand, p.gtin, p.mpn, p.sku, p.url,
          s.name as shop, s.slug,
          word_similarity(${q}, p.title) as score,
          lo.price_cents, lo.was_price_cents, lo.in_stock, lo.observed_at,
          (select min(po.price_cents) from price_observations po
             where po.product_id = p.id and po.observed_at > now() - interval '30 days' and po.price_cents > 0) as low_30d_cents
        from products p
        join shops s on s.id = p.shop_id
        cross join lateral (
          select price_cents, was_price_cents, in_stock, observed_at from price_observations
          where product_id = p.id order by observed_at desc limit 1
        ) lo
        where ${q} <% p.title and s.active and (${shop}::text is null or s.slug = ${shop})
          and p.last_seen > now() - interval '3 days'
        order by score desc, lo.price_cents asc nulls last
        limit 150`,
    ]);
    return json({ results: rows });
  }

  const shopMatch = /^\/api\/shop\/([a-z0-9-]+)$/.exec(p);
  if (shopMatch) {
    const slug = shopMatch[1]!;
    const [shop] = await sql`select id, slug, name, base_url, adapter, category, tier, notes from shops where slug = ${slug}`;
    if (!shop) return json({ error: 'unknown shop' }, 404);
    const runs = await sql`
      select kind, status, products_seen, requests, failed_requests, errors, started_at, finished_at, notes
      from scrape_runs where shop_id = ${shop.id} order by started_at desc limit 10`;
    const [stats] = await sql`
      select count(*)::int as products,
        count(*) filter (where p.watch_tier = 'warm')::int as warm,
        count(*) filter (where p.watch_tier = 'hot')::int as hot,
        count(*) filter (where p.last_seen > now() - interval '2 days')::int as listed_now
      from products p where p.shop_id = ${shop.id}`;
    const changes = await sql`
      with obs as (
        select po.product_id, po.price_cents, po.observed_at,
          row_number() over (partition by po.product_id order by po.observed_at desc) as rn
        from price_observations po
        join products p on p.id = po.product_id
        where p.shop_id = ${shop.id} and po.observed_at > now() - interval '8 days' and po.price_cents > 0
      )
      select p.id, p.title, p.variant_title, p.url, a.price_cents as now_cents, b.price_cents as prev_cents,
        a.observed_at, b.observed_at as prev_at,
        round(100.0 * (a.price_cents - b.price_cents) / b.price_cents, 1)::float as pct
      from obs a
      join obs b on b.product_id = a.product_id and b.rn = 2
      join products p on p.id = a.product_id
      where a.rn = 1 and a.price_cents <> b.price_cents
      order by abs(a.price_cents - b.price_cents)::float / b.price_cents desc
      limit 60`;
    const discounts = await sql`
      with latest as (
        select distinct on (po.product_id) po.product_id, po.price_cents, po.was_price_cents, po.observed_at
        from price_observations po join products p on p.id = po.product_id
        where p.shop_id = ${shop.id} and po.observed_at > now() - interval '2 days'
        order by po.product_id, po.observed_at desc
      )
      select p.id, p.title, p.variant_title, p.url, l.price_cents as now_cents, l.was_price_cents,
        round(100.0 * (l.was_price_cents - l.price_cents) / l.was_price_cents, 1)::float as claimed_pct,
        (select min(po.price_cents) from price_observations po
           where po.product_id = p.id and po.observed_at > now() - interval '30 days' and po.price_cents > 0) as low_30d_cents
      from latest l join products p on p.id = l.product_id
      where l.was_price_cents > l.price_cents and l.price_cents > 0
      order by (l.was_price_cents - l.price_cents)::float / l.was_price_cents desc
      limit 60`;
    return json({ shop, runs, stats, changes, discounts });
  }

  const productMatch = /^\/api\/product\/(\d+)$/.exec(p);
  if (productMatch) {
    const id = Number(productMatch[1]);
    const [product] = await sql`
      select p.id, p.title, p.variant_title, p.brand, p.sku, p.gtin, p.mpn, p.url, p.category_path, p.tags,
        p.first_seen, p.last_seen, p.watch_tier, s.name as shop, s.slug
      from products p join shops s on s.id = p.shop_id where p.id = ${id}`;
    if (!product) return json({ error: 'unknown product' }, 404);
    const history = await sql`
      select observed_at, price_cents, was_price_cents, shop_30d_low_cents, in_stock, review_flag
      from price_observations where product_id = ${id} and observed_at > now() - interval '60 days'
      order by observed_at`;
    return json({ product, history });
  }

  return json({ error: 'not found' }, 404);
}
