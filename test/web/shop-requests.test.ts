// Admin API for shop requests (web/worker/shop-requests.ts via web/worker/admin.ts). Unit tests use a fake store;
// the PGlite block applies every migration with site_admin and dashboard_ro already present, so the grants of
// 009_shop_requests.sql are what is tested, and runs the real SQL as site_admin.
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type AdminRunner, type AdminStore, createAdminStore, handleAdmin } from '../../web/worker/admin.js';
import type { Env } from '../../web/worker/env.js';
import type { AdminShopRequest } from '../../web/worker/shop-requests.js';

const SITE = 'https://guide.example';
const env: Env = {
  DATABASE_URL: 'postgres://ro@example/db',
  REPORTER_DATABASE_URL: 'postgres://reporter@example/db',
  ADMIN_DATABASE_URL: 'postgres://admin@example/db',
  SITE_PASSWORD: 'site-secret',
  ADMIN_PASSWORD: 'admin-secret',
  SITE_ORIGIN: SITE,
  IP_SALT: 'salt',
};
const ADMIN_AUTH = `Basic ${btoa('owner:admin-secret')}`;

const sample: AdminShopRequest = {
  id: 3,
  origin: 'https://shop.example.mt',
  name: null,
  category: null,
  status: 'pending',
  requestedAt: '2026-10-23T08:00:00.000Z',
  startedAt: null,
  checkedAt: null,
  platform: null,
  robots: null,
  productsFound: null,
  sample: [],
  details: null,
  error: null,
  attempts: 0,
  nextCheckAt: null,
  shop: null,
};

function fakeStore() {
  return {
    shopRequests: vi.fn(async () => [sample]),
    createShopRequest: vi.fn(async (input: { origin: string; name: string | null; category: string | null }) => ({ request: { ...sample, ...input } })),
    setShopRequestStatus: vi.fn(async (id: number, status: string) => ({ ...sample, id, status })),
  };
}

function setup(store = fakeStore()) {
  const deps = { store: () => store as unknown as AdminStore };
  const send = (method: string, p: string, body?: unknown, headers: Record<string, string | null> = {}) => {
    const merged: Record<string, string | null> = { authorization: ADMIN_AUTH, ...(method === 'GET' ? {} : { 'content-type': 'application/json', origin: SITE }), ...headers };
    const h = Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== null));
    const req = new Request(`${SITE}${p}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return handleAdmin(req, env, new URL(req.url), deps);
  };
  return { store, send };
}

describe('shop request routes: admin auth', () => {
  it('refuses every route without the admin password, before any store call, never cached', async () => {
    const w = setup();
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/admin/shop-requests'],
      ['POST', '/api/admin/shop-requests', { url: 'https://shop.example.mt' }],
      ['PATCH', '/api/admin/shop-requests/3', { status: 'rejected' }],
    ];
    const auths = [null, `Basic ${btoa('owner:site-secret')}`, `Basic ${btoa('owner:wrong')}`];
    const results = await Promise.all(routes.flatMap(([m, p, b]) => auths.map(async (a) => ({ label: `${m} ${p} ${a}`, res: await w.send(m, p, b, { authorization: a }) }))));
    for (const { label, res } of results) {
      expect(res.status, label).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    for (const fn of Object.values(w.store)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/shop-requests', () => {
  it('lists the requests, no-store', async () => {
    const w = setup();
    const res = await w.send('GET', '/api/admin/shop-requests');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ requests: [sample], maxQueued: 20 });
  });

  it('other methods get 405', async () => {
    const w = setup();
    expect((await w.send('PUT', '/api/admin/shop-requests', {})).status).toBe(405);
    expect((await w.send('DELETE', '/api/admin/shop-requests/3')).status).toBe(405);
  });
});

describe('POST /api/admin/shop-requests', () => {
  it('stores the origin only, with a cleaned name and the category; 201', async () => {
    const w = setup();
    const res = await w.send('POST', '/api/admin/shop-requests', { url: 'shop.Example.mt/collections/all?x=1', name: '  My   Shop ', category: 'toys' });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(w.store.createShopRequest).toHaveBeenCalledWith({ origin: 'https://shop.example.mt', host: 'shop.example.mt', name: 'My Shop', category: 'toys' });
    expect(((await res.json()) as { request: AdminShopRequest }).request.origin).toBe('https://shop.example.mt');
  });

  it('name and category are optional; blank means none', async () => {
    const w = setup();
    expect((await w.send('POST', '/api/admin/shop-requests', { url: 'https://shop.example.mt', name: '  ', category: '' })).status).toBe(201);
    expect((await w.send('POST', '/api/admin/shop-requests', { url: 'https://shop.example.mt', name: null, category: null })).status).toBe(201);
    expect(w.store.createShopRequest).toHaveBeenLastCalledWith(expect.objectContaining({ name: null, category: null }));
  });

  it('refuses bad addresses with the reason, and never stores them', async () => {
    const w = setup();
    const cases: [string, string][] = [
      ['ftp://shop.example.mt', 'scheme'],
      ['http://127.0.0.1/', 'ip'],
      ['http://2130706433/', 'ip'],
      ['http://0x7f.0.0.1/', 'ip'],
      ['http://[::1]/', 'ip'],
      ['http://[::ffff:10.0.0.1]/', 'ip'],
      ['https://user:pw@shop.example.mt', 'credentials'],
      ['https://shop.example.mt:8443', 'port'],
      ['http://localhost', 'host'],
      ['https://nas.local', 'host'],
      ['https://intranet', 'host'],
      ['', 'empty'],
    ];
    for (const [url, reason] of cases) {
      const res = await w.send('POST', '/api/admin/shop-requests', { url });
      expect(res.status, url).toBe(400);
      expect(await res.json(), url).toEqual({ error: 'invalid', field: 'url', reason });
    }
    expect(w.store.createShopRequest).not.toHaveBeenCalled();
  });

  it('refuses a long name, an unknown category, unknown keys and a missing url', async () => {
    const w = setup();
    const bad: [unknown, string][] = [
      [{ url: 'https://shop.example.mt', name: 'x'.repeat(81) }, 'name'],
      [{ url: 'https://shop.example.mt', category: 'weapons' }, 'category'],
      [{ url: 'https://shop.example.mt', extra: 1 }, ''],
      [{ name: 'x' }, 'url'],
      [{ url: 42 }, 'url'],
    ];
    for (const [body, field] of bad) {
      const res = await w.send('POST', '/api/admin/shop-requests', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { field: string }).field, JSON.stringify(body)).toBe(field);
    }
    expect(w.store.createShopRequest).not.toHaveBeenCalled();
  });

  it('a host already in shops or already requested gives 409; a full queue gives 429', async () => {
    const w = setup();
    w.store.createShopRequest.mockResolvedValueOnce({ duplicate: 'shop', slug: 'klikk' } as never);
    let res = await w.send('POST', '/api/admin/shop-requests', { url: 'https://klikk.com.mt' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'duplicate', field: 'url', reason: 'shop', slug: 'klikk' });
    w.store.createShopRequest.mockResolvedValueOnce({ duplicate: 'request', status: 'failed' } as never);
    res = await w.send('POST', '/api/admin/shop-requests', { url: 'https://shop.example.mt' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'duplicate', field: 'url', reason: 'request', status: 'failed' });
    w.store.createShopRequest.mockResolvedValueOnce({ full: true } as never);
    res = await w.send('POST', '/api/admin/shop-requests', { url: 'https://other.example.mt' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'too many pending', max: 20 });
  });

  it('needs the same Origin, application/json, a small body and valid JSON', async () => {
    const w = setup();
    const p = '/api/admin/shop-requests';
    expect((await w.send('POST', p, { url: 'https://shop.example.mt' }, { origin: null })).status).toBe(403);
    expect((await w.send('POST', p, { url: 'https://shop.example.mt' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await w.send('POST', p, { url: 'https://shop.example.mt' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await w.send('POST', p, { url: 'https://shop.example.mt', name: 'x'.repeat(9000) })).status).toBe(413);
    expect((await w.send('POST', p, '{nope')).status).toBe(400);
    expect(w.store.createShopRequest).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/shop-requests/:id', () => {
  it('retry goes back to pending from failed or blocked only; reject from the open statuses', async () => {
    const w = setup();
    expect((await w.send('PATCH', '/api/admin/shop-requests/3', { status: 'pending' })).status).toBe(200);
    expect(w.store.setShopRequestStatus).toHaveBeenLastCalledWith(3, 'pending', ['failed', 'blocked']);
    expect((await w.send('PATCH', '/api/admin/shop-requests/3', { status: 'rejected' })).status).toBe(200);
    expect(w.store.setShopRequestStatus).toHaveBeenLastCalledWith(3, 'rejected', ['pending', 'checking', 'needs_setup', 'blocked', 'failed']);
  });

  it('a retry refused by the 20 open cap gives 429', async () => {
    const w = setup();
    w.store.setShopRequestStatus.mockResolvedValueOnce('full' as never);
    const res = await w.send('PATCH', '/api/admin/shop-requests/3', { status: 'pending' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'too many pending', max: 20 });
  });

  it('only pending and rejected can be set; bad ids are 404; a wrong current status is 409', async () => {
    const w = setup();
    for (const status of ['active', 'checking', 'failed', 'needs_setup']) expect((await w.send('PATCH', '/api/admin/shop-requests/3', { status })).status, status).toBe(400);
    expect((await w.send('PATCH', '/api/admin/shop-requests/3', { status: 'rejected', error: 'x' })).status).toBe(400);
    expect((await w.send('PATCH', '/api/admin/shop-requests/abc', { status: 'rejected' })).status).toBe(404);
    w.store.setShopRequestStatus.mockResolvedValueOnce(null as never);
    expect((await w.send('PATCH', '/api/admin/shop-requests/9', { status: 'rejected' })).status).toBe(404);
    w.store.setShopRequestStatus.mockResolvedValueOnce('conflict' as never);
    const res = await w.send('PATCH', '/api/admin/shop-requests/3', { status: 'pending' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict' });
    expect((await w.send('PATCH', '/api/admin/shop-requests/3', { status: 'rejected' }, { origin: null })).status).toBe(403);
  });
});

describe('create-site-roles.ts', () => {
  it('grants site_admin the same shop_requests rights as migration 009, so a re-run keeps them', () => {
    const script = readFileSync('scripts/create-site-roles.ts', 'utf8');
    expect(script).toContain("'select on shop_requests'");
    expect(script).toContain("'insert (origin, display_name, shop_category) on shop_requests'");
    expect(script).toContain("'update (status) on shop_requests'");
    expect(script).toContain("'usage on sequence shop_requests_id_seq'");
  });
});

describe('shop request store on PGlite as site_admin', () => {
  let pg: PGlite;
  let store: AdminStore;

  function adminRunner(db: PGlite): AdminRunner {
    const tx = (statements: { text: string; params: unknown[] }[]) =>
      db.transaction(async (t) => {
        await t.query('set local role site_admin');
        const out: Record<string, unknown>[][] = [];
        for (const s of statements) out.push((await t.query<Record<string, unknown>>(s.text, s.params)).rows);
        return out;
      });
    return { query: async (text, params) => (await tx([{ text, params }]))[0]!, transaction: tx };
  }
  const asRole = (role: string, text: string) =>
    pg.transaction(async (t) => {
      await t.query(`set local role ${role}`);
      return (await t.query(text)).rows;
    });

  beforeAll(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    pg = await PGlite.create({ dataDir: 'memory://', extensions: { pg_trgm } });
    // both roles exist before the migrations, as on Neon; dashboard_ro reads new tables by default
    await pg.exec(`
      create role site_admin;
      create role dashboard_ro;
      alter default privileges in schema public grant select on tables to dashboard_ro;
    `);
    const dir = path.resolve('db/migrations');
    for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(await readFile(path.join(dir, f), 'utf8'));
    await pg.exec(`
      grant usage on schema public to site_admin;
      grant select on shops to site_admin;
      insert into shops (id, slug, name, base_url, adapter, active) values
        (1, 'klikk', 'Klikk', 'https://www.klikk.com.mt', 'shopify', true),
        (2, 'scan', 'Scan', 'https://www.scanmalta.com/shop', 'magento', true);
    `);
    store = createAdminStore(adminRunner(pg));
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  it('creates a pending request and lists requests newest first', async () => {
    const a = await store.createShopRequest({ origin: 'https://shop.example.mt', host: 'shop.example.mt', name: 'Shop', category: 'toys' });
    expect('request' in a && a.request).toMatchObject({ origin: 'https://shop.example.mt', name: 'Shop', category: 'toys', status: 'pending', attempts: 0, sample: [], shop: null });
    const b = await store.createShopRequest({ origin: 'https://second.example.mt', host: 'second.example.mt', name: null, category: null });
    expect('request' in b).toBe(true);
    const list = await store.shopRequests();
    expect(list.map((r) => r.origin)).toEqual(['https://second.example.mt', 'https://shop.example.mt']);
    expect(typeof list[0]!.requestedAt).toBe('string');
  });

  it('refuses a host already in shops (with or without www.) or already requested', async () => {
    expect(await store.createShopRequest({ origin: 'https://klikk.com.mt', host: 'klikk.com.mt', name: null, category: null })).toEqual({ duplicate: 'shop', slug: 'klikk' });
    expect(await store.createShopRequest({ origin: 'https://scanmalta.com', host: 'scanmalta.com', name: null, category: null })).toEqual({ duplicate: 'shop', slug: 'scan' });
    expect(await store.createShopRequest({ origin: 'https://www.shop.example.mt', host: 'shop.example.mt', name: null, category: null })).toEqual({ duplicate: 'request', status: 'pending' });
  });

  it('retry and reject follow the allowed statuses; a rejected address can be requested again', async () => {
    const [req] = (await pg.query<{ id: number }>(`select id from shop_requests where origin = 'https://shop.example.mt'`)).rows;
    const id = Number(req!.id);
    expect(await store.setShopRequestStatus(id, 'pending', ['failed', 'blocked'])).toBe('conflict');
    await pg.query(`update shop_requests set status = 'failed', error = 'Only 4 products', products_found = 4,
      sample = '[{"title":"<b>Robot</b>","priceCents":3999,"url":"https://shop.example.mt/p/1"}]', robots = '{"status":"ok","allowed":true,"crawlDelaySeconds":5,"checked":[],"blockedBy":null}',
      platform = 'shopify', shop_id = 1 where id = $1`, [id]);
    const retried = await store.setShopRequestStatus(id, 'pending', ['failed', 'blocked']);
    // once a shop exists, the list carries its stored name
    expect(retried).toMatchObject({ id, status: 'pending', error: 'Only 4 products', productsFound: 4, platform: 'shopify', shop: { slug: 'klikk', name: 'Klikk', active: true } });
    expect(typeof retried === 'object' && retried?.sample).toEqual([{ title: '<b>Robot</b>', priceCents: 3999, url: 'https://shop.example.mt/p/1' }]);
    expect(typeof retried === 'object' && retried?.robots).toMatchObject({ allowed: true, crawlDelaySeconds: 5 });
    expect(await store.setShopRequestStatus(id, 'rejected', ['pending', 'needs_setup', 'blocked', 'failed'])).toMatchObject({ status: 'rejected' });
    expect(await store.setShopRequestStatus(999_999, 'rejected', ['pending'])).toBeNull();
    const again = await store.createShopRequest({ origin: 'https://shop.example.mt', host: 'shop.example.mt', name: null, category: null });
    expect('request' in again).toBe(true);
  });

  it('at most 20 requests may wait or be checked at once', async () => {
    const { rows } = await pg.query<{ n: number }>(`select count(*)::int as n from shop_requests where status in ('pending', 'checking')`);
    for (let i = Number(rows[0]!.n); i < 20; i++) {
      const r = await store.createShopRequest({ origin: `https://bulk${i}.example.mt`, host: `bulk${i}.example.mt`, name: null, category: null });
      expect('request' in r).toBe(true);
    }
    expect(await store.createShopRequest({ origin: 'https://one-too-many.example.mt', host: 'one-too-many.example.mt', name: null, category: null })).toEqual({ full: true });
    // a retry is refused by the same cap, inside the update
    const { rows: failed } = await pg.query<{ id: number }>(`insert into shop_requests (origin, status) values ('https://was-failed.example.mt', 'failed') returning id`);
    const id = Number(failed[0]!.id);
    expect(await store.setShopRequestStatus(id, 'pending', ['failed', 'blocked'])).toBe('full');
    expect((await pg.query<{ status: string }>('select status from shop_requests where id = $1', [id])).rows[0]!.status).toBe('failed');
    // rejecting is never capped, also while a check runs
    await pg.query(`update shop_requests set status = 'checking' where origin = 'https://bulk19.example.mt'`);
    const [{ id: busy }] = (await pg.query<{ id: number }>(`select id from shop_requests where origin = 'https://bulk19.example.mt'`)).rows as { id: number }[];
    expect(await store.setShopRequestStatus(Number(busy), 'rejected', ['pending', 'checking', 'needs_setup', 'blocked', 'failed'])).toMatchObject({ status: 'rejected' });
  });

  it('a rate-limited request shows when it is checked again', async () => {
    await pg.query(`update shop_requests set next_check_at = '2026-10-23T12:00:00Z' where origin = 'https://bulk18.example.mt'`);
    const r = (await store.shopRequests()).find((x) => x.origin === 'https://bulk18.example.mt')!;
    expect(r.nextCheckAt).toBe('2026-10-23T12:00:00.000Z');
  });

  it('unreadable stored JSON comes back as null or empty, never as raw values', async () => {
    await pg.query(`update shop_requests set sample = '"not a list"', robots = '[1,2]', details = '{"generator":"x","categoryLinks":[1,"/c/a"]}' where origin = 'https://second.example.mt'`);
    const r = (await store.shopRequests()).find((x) => x.origin === 'https://second.example.mt')!;
    expect(r.sample).toEqual([]);
    expect(r.robots).toBeNull();
    expect(r.details).toMatchObject({ generator: [], categoryLinks: ['/c/a'] });
  });

  it('site_admin may change the status only, and may not insert other columns', async () => {
    await expect(asRole('site_admin', `update shop_requests set error = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(asRole('site_admin', `update shop_requests set shop_id = 1`)).rejects.toThrow(/permission denied/);
    await expect(asRole('site_admin', `insert into shop_requests (origin, status) values ('https://x.example.mt', 'active')`)).rejects.toThrow(/permission denied/);
    await expect(asRole('site_admin', `delete from shop_requests`)).rejects.toThrow(/permission denied/);
  });

  it('dashboard_ro cannot read shop requests', async () => {
    await expect(asRole('dashboard_ro', 'select * from shop_requests')).rejects.toThrow(/permission denied/);
    // its default read access to other new tables is untouched
    expect(await asRole('dashboard_ro', 'select count(*) from shops')).toHaveLength(1);
  });
});
