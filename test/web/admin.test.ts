// Admin API (web/worker/admin.ts). Unit tests use a fake store; the PGlite block runs the real SQL as site_admin
// with the grants of scripts/create-site-roles.ts, and checks that a saved phrase reaches GET /api/home.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type SiteSettings, phraseProblem, settingsFromRows } from '../../src/site/settings.js';
import { type AdminRunner, type AdminStore, createAdminStore, handleAdmin, settingsSchema } from '../../web/worker/admin.js';
import { handleApi } from '../../web/worker/api.js';
import { createData, type SqlRunner } from '../../web/worker/data.js';
import type { Env } from '../../web/worker/env.js';
import { type Bindings, createHandler } from '../../web/worker/index.js';
import { loadSiteSettings, resetSiteSettingsCache } from '../../web/worker/settings.js';

const SITE = 'https://guide.example';
const baseEnv: Env = {
  DATABASE_URL: 'postgres://ro@example/db',
  REPORTER_DATABASE_URL: 'postgres://reporter@example/db',
  ADMIN_DATABASE_URL: 'postgres://admin@example/db',
  SITE_PASSWORD: 'site-secret',
  ADMIN_PASSWORD: 'admin-secret',
  SITE_ORIGIN: SITE,
  IP_SALT: 'salt',
};
const ADMIN_AUTH = `Basic ${btoa('owner:admin-secret')}`;

function fakeStore(): AdminStore & { [K in keyof AdminStore]: ReturnType<typeof vi.fn> } {
  return {
    settingsRows: vi.fn(async () => [{ key: 'thresholds', value: { raisePct: 4 } }]),
    saveSettings: vi.fn(async () => {}),
    reports: vi.fn(async () => ({ items: [], total: 0 })),
    updateReport: vi.fn(async (id: number, status: string, note: string | null | undefined) => ({
      id,
      targetType: 'product',
      targetId: 1,
      target: { link: null, label: null },
      reason: 'other',
      message: null,
      email: null,
      status,
      adminNote: note ?? null,
      createdAt: '2026-10-22T10:00:00.000Z',
      resolvedAt: status === 'open' ? null : '2026-10-22T11:00:00.000Z',
    })),
    shops: vi.fn(async () => []),
    setShopHidden: vi.fn(async (slug: string, hidden: boolean) => ({ slug, hidden })),
    matches: vi.fn(async () => ({ groups: [], total: 0 })),
    confirmMatch: vi.fn(async (id: number, confirmed: boolean) => ({ id, confirmed })),
    unmappedCategories: vi.fn(async () => [{ path: 'Gadgets > Misc', count: 4 }]),
  } as never;
}

function setup(opts: { store?: AdminStore } = {}) {
  const store = opts.store ?? fakeStore();
  const invalidateSettings = vi.fn();
  const deps = { store: () => store, invalidateSettings };
  /** a null header value leaves that header out */
  const send = (method: string, p: string, body?: unknown, headers: Record<string, string | null> = {}) => {
    const merged: Record<string, string | null> = { authorization: ADMIN_AUTH, ...(method === 'GET' ? {} : { 'content-type': 'application/json', origin: SITE }), ...headers };
    const h = Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== null));
    const req = new Request(`${SITE}${p}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return handleAdmin(req, baseEnv, new URL(req.url), deps);
  };
  return { store: store as ReturnType<typeof fakeStore>, invalidateSettings, send };
}

const clone = (): SiteSettings => structuredClone(DEFAULT_SETTINGS);

describe('phraseProblem', () => {
  it('accepts the default phrases in their slots', () => {
    for (const [slot, lines] of Object.entries(DEFAULT_SETTINGS.phrases)) for (const l of lines) expect(phraseProblem(l, slot as never)).toBeNull();
  });

  it('rejects short, long, unbalanced, empty-pair, control characters and {days} outside bfweek', () => {
    expect(phraseProblem('  ab  ', 'morning')).toMatch(/3 to 120/);
    expect(phraseProblem('x'.repeat(121), 'morning')).toMatch(/3 to 120/);
    expect(phraseProblem(`  ${'x'.repeat(120)}  `, 'morning')).toBeNull();
    expect(phraseProblem('Is that *real?', 'morning')).toMatch(/\*/);
    expect(phraseProblem('Is that ** real?', 'morning')).toMatch(/\*/);
    expect(phraseProblem('Tab\there', 'morning')).toMatch(/control/i);
    expect(phraseProblem('*{days}* left', 'morning')).toMatch(/\{days\}/);
    expect(phraseProblem('*{days}* left', 'bfweek')).toBeNull();
  });
});

describe('settingsSchema', () => {
  it('parses the defaults and trims phrases', () => {
    const s = clone();
    s.phrases.morning = ['  Coffee *first*.  '];
    const out = settingsSchema.parse(s);
    expect(out.phrases.morning).toEqual(['Coffee *first*.']);
    expect(out.thresholds).toEqual(DEFAULT_SETTINGS.thresholds);
  });

  it('enforces each threshold range and integer thresholds', () => {
    const bad: [string, number][] = [
      ['minHistoryDays', 0], ['minHistoryDays', 91], ['minHistoryDays', 14.5],
      ['baselineDays', 6], ['baselineDays', 121],
      ['raiseWindowDays', 0], ['raiseWindowDays', 61],
      ['raisePct', 0.4], ['raisePct', 50.1], ['raisePct', -1],
      ['goodDropPct', 0.4], ['goodDropPct', 90.5],
      ['cheaperPct', -0.1], ['cheaperPct', 51],
      ['minJudgedForRating', 0], ['minJudgedForRating', 1001], ['minJudgedForRating', 2.5],
    ];
    for (const [k, v] of bad) {
      const s = clone();
      (s.thresholds as Record<string, number>)[k] = v;
      expect(settingsSchema.safeParse(s).success, `${k}=${v}`).toBe(false);
    }
    const ok = clone();
    Object.assign(ok.thresholds, { minHistoryDays: 90, baselineDays: 7, raiseWindowDays: 60, raisePct: 0.5, goodDropPct: 90, cheaperPct: 0, minJudgedForRating: 1000 });
    expect(settingsSchema.safeParse(ok).success).toBe(true);
  });

  it('needs 1 to 30 phrases in every slot and rejects unknown keys anywhere', () => {
    const empty = clone();
    empty.phrases.late = [];
    expect(settingsSchema.safeParse(empty).success).toBe(false);
    const many = clone();
    many.phrases.late = Array.from({ length: 31 }, (_, i) => `Line number ${i}`);
    expect(settingsSchema.safeParse(many).success).toBe(false);
    many.phrases.late = many.phrases.late.slice(0, 30);
    expect(settingsSchema.safeParse(many).success).toBe(true);
    expect(settingsSchema.safeParse({ ...clone(), extra: 1 }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...clone(), thresholds: { ...DEFAULT_SETTINGS.thresholds, other: 1 } }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...clone(), phrases: { ...DEFAULT_SETTINGS.phrases, night: ['Hello there'] } }).success).toBe(false);
    const { categoryOverrides: _, ...missing } = clone();
    expect(settingsSchema.safeParse(missing).success).toBe(false);
  });

  it('bounds category overrides: lowercase trimmed keys without separators, site slugs, at most 500', () => {
    const s = clone();
    s.categoryOverrides = { gadgets: 'tv-audio', 'small appliances': 'appliances' };
    expect(settingsSchema.safeParse(s).success).toBe(true);
    for (const o of [{ gadgets: 'nope' }, { Gadgets: 'tv-audio' }, { ' gadgets': 'tv-audio' }, { 'a > b': 'toys' }, { '': 'toys' }, { ['x'.repeat(101)]: 'toys' }]) {
      expect(settingsSchema.safeParse({ ...clone(), categoryOverrides: o }).success, JSON.stringify(o)).toBe(false);
    }
    const big = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`cat ${i}`, 'other']));
    expect(settingsSchema.safeParse({ ...clone(), categoryOverrides: big }).success).toBe(false);
  });
});

describe('admin auth (second layer)', () => {
  const routes: [string, string, unknown?][] = [
    ['GET', '/api/admin/settings'],
    ['PUT', '/api/admin/settings', DEFAULT_SETTINGS],
    ['GET', '/api/admin/categories'],
    ['GET', '/api/admin/reports'],
    ['PATCH', '/api/admin/reports/5', { status: 'fixed' }],
    ['GET', '/api/admin/shops'],
    ['PATCH', '/api/admin/shops/alpha', { hidden: true }],
    ['GET', '/api/admin/matches?pending=1'],
    ['PATCH', '/api/admin/matches/7', { confirmed: true }],
    ['GET', '/api/admin/nothing'],
  ];

  it('refuses every admin route called directly without the admin password, before any store call', async () => {
    const w = setup();
    const auths = [null, `Basic ${btoa('owner:site-secret')}`, `Basic ${btoa('owner:wrong')}`];
    // in parallel: each refusal waits 750 ms
    const results = await Promise.all(routes.flatMap(([method, p, body]) => auths.map(async (auth) => ({ label: `${method} ${p} ${auth}`, res: await w.send(method, p, body, { authorization: auth }) }))));
    for (const { label, res } of results) {
      expect(res.status, label).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    for (const fn of Object.values(w.store)) expect(fn).not.toHaveBeenCalled();
  });

  it('through the Worker, every admin route without auth gives 401 even when the site is public', async () => {
    const store = fakeStore();
    const env: Bindings = { ...baseEnv, ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) } };
    const handler = createHandler({
      loadSettings: async () => ({ public: true }),
      api: { data: () => ({}) as never, cache: () => null, admin: { store: () => store } },
    });
    const results = await Promise.all(
      routes.map(async ([method, p, body]) => ({
        label: `${method} ${p}`,
        res: await handler.fetch(
          new Request(`${SITE}${p}`, { method, headers: { 'content-type': 'application/json', origin: SITE }, body: body === undefined ? undefined : JSON.stringify(body) }),
          env,
        ),
      })),
    );
    for (const { label, res } of results) {
      expect(res.status, label).toBe(401);
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it('the admin page and admin API are noindex even while the site is public', async () => {
    const env: Bindings = { ...baseEnv, ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) } };
    const handler = createHandler({ loadSettings: async () => ({ public: true }), api: { data: () => ({}) as never, cache: () => null, admin: { store: () => fakeStore() } } });
    const page = await handler.fetch(new Request(`${SITE}/admin/reports`, { headers: { authorization: ADMIN_AUTH } }), env);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const apiRes = await handler.fetch(new Request(`${SITE}/api/admin/settings`, { headers: { authorization: ADMIN_AUTH } }), env);
    expect(apiRes.status).toBe(200);
    expect(apiRes.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(apiRes.headers.get('cache-control')).toBe('no-store');
    const home = await handler.fetch(new Request(`${SITE}/`), env);
    expect(home.headers.get('x-robots-tag')).toBeNull();
  });
});

describe('GET/PUT /api/admin/settings', () => {
  it('GET merges stored rows over the defaults, no-store', async () => {
    const w = setup();
    const res = await w.send('GET', '/api/admin/settings');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { settings: SiteSettings };
    expect(body.settings.thresholds.raisePct).toBe(4);
    expect(body.settings.phrases).toEqual(DEFAULT_SETTINGS.phrases);
  });

  it('PUT with raisePct -1 gives 400 naming the field, nothing saved', async () => {
    const w = setup();
    const s = clone();
    s.thresholds.raisePct = -1;
    const res = await w.send('PUT', '/api/admin/settings', s);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid', field: 'thresholds.raisePct' });
    expect(w.store.saveSettings).not.toHaveBeenCalled();
    expect(w.invalidateSettings).not.toHaveBeenCalled();
  });

  it('PUT with an unbalanced * gives 400', async () => {
    const w = setup();
    const s = clone();
    s.phrases.evening = ['Fine *line*.', 'Broken *line.'];
    const res = await w.send('PUT', '/api/admin/settings', s);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid', field: 'phrases.evening.1' });
    expect(w.store.saveSettings).not.toHaveBeenCalled();
  });

  it('PUT saves the validated settings, clears the access settings cache and answers with them', async () => {
    const w = setup();
    const s = clone();
    s.public = true;
    s.phrases.morning = ['  Rise and *check*.  '];
    const res = await w.send('PUT', '/api/admin/settings', s);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const saved = { ...s, phrases: { ...s.phrases, morning: ['Rise and *check*.'] } };
    expect(w.store.saveSettings).toHaveBeenCalledWith(saved);
    expect(await res.json()).toEqual({ settings: saved });
    expect(w.invalidateSettings).toHaveBeenCalledTimes(1);
  });

  it('PUT needs same Origin, application/json, a body under the cap and valid JSON', async () => {
    const w = setup();
    expect((await w.send('PUT', '/api/admin/settings', DEFAULT_SETTINGS, { origin: null })).status).toBe(403);
    expect((await w.send('PUT', '/api/admin/settings', DEFAULT_SETTINGS, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await w.send('PUT', '/api/admin/settings', DEFAULT_SETTINGS, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await w.send('PUT', '/api/admin/settings', 'x'.repeat(300 * 1024))).status).toBe(413);
    const broken = await w.send('PUT', '/api/admin/settings', '{"public":');
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: 'body' });
    expect(w.store.saveSettings).not.toHaveBeenCalled();
  });

  it('other methods get 405, unknown admin paths 404', async () => {
    const w = setup();
    const del = await w.send('DELETE', '/api/admin/settings');
    expect(del.status).toBe(405);
    expect(del.headers.get('allow')).toBe('GET, PUT');
    expect((await w.send('GET', '/api/admin/nothing')).status).toBe(404);
    expect((await w.send('GET', '/api/admin')).status).toBe(404);
  });
});

describe('GET /api/admin/categories', () => {
  it('lists the most common unmapped shop categories', async () => {
    const w = setup();
    const res = await w.send('GET', '/api/admin/categories');
    expect(await res.json()).toEqual({ unmapped: [{ path: 'Gadgets > Misc', count: 4 }] });
  });
});

describe('/api/admin/reports', () => {
  it('GET defaults to open, page 1, 50 per page; validates status and page', async () => {
    const w = setup();
    const res = await w.send('GET', '/api/admin/reports');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
    expect(w.store.reports).toHaveBeenCalledWith('open', 50, 0);
    await w.send('GET', '/api/admin/reports?status=hidden&page=3');
    expect(w.store.reports).toHaveBeenLastCalledWith('hidden', 50, 100);
    expect((await w.send('GET', '/api/admin/reports?status=closed')).status).toBe(400);
    expect((await w.send('GET', '/api/admin/reports?page=0')).status).toBe(400);
    expect((await w.send('GET', '/api/admin/reports?page=x')).status).toBe(400);
  });

  it('PATCH validates status, note length and id; passes a cleaned note', async () => {
    const w = setup();
    expect((await w.send('PATCH', '/api/admin/reports/5', { status: 'done' })).status).toBe(400);
    expect((await w.send('PATCH', '/api/admin/reports/5', { status: 'fixed', adminNote: 'x'.repeat(1001) })).status).toBe(400);
    expect((await w.send('PATCH', '/api/admin/reports/5', { status: 'fixed', extra: 1 })).status).toBe(400);
    expect((await w.send('PATCH', '/api/admin/reports/abc', { status: 'fixed' })).status).toBe(404);
    expect(w.store.updateReport).not.toHaveBeenCalled();
    const res = await w.send('PATCH', '/api/admin/reports/5', { status: 'fixed', adminNote: '  Price corrected.  ' });
    expect(res.status).toBe(200);
    expect(w.store.updateReport).toHaveBeenCalledWith(5, 'fixed', 'Price corrected.');
    await w.send('PATCH', '/api/admin/reports/5', { status: 'kept', adminNote: '   ' });
    expect(w.store.updateReport).toHaveBeenLastCalledWith(5, 'kept', null);
    await w.send('PATCH', '/api/admin/reports/5', { status: 'open' });
    expect(w.store.updateReport).toHaveBeenLastCalledWith(5, 'open', undefined);
  });

  it('PATCH an unknown report gives 404; PATCH needs Origin', async () => {
    const store = fakeStore();
    store.updateReport.mockResolvedValueOnce(null);
    const w = setup({ store });
    expect((await w.send('PATCH', '/api/admin/reports/99', { status: 'fixed' })).status).toBe(404);
    expect((await w.send('PATCH', '/api/admin/reports/99', { status: 'fixed' }, { origin: null })).status).toBe(403);
  });
});

describe('/api/admin/shops and /api/admin/matches', () => {
  it('PATCH shop takes { hidden: boolean } only', async () => {
    const w = setup();
    expect((await w.send('PATCH', '/api/admin/shops/alpha', { hidden: 'yes' })).status).toBe(400);
    expect((await w.send('PATCH', '/api/admin/shops/Bad_Slug!', { hidden: true })).status).toBe(404);
    const res = await w.send('PATCH', '/api/admin/shops/alpha', { hidden: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shop: { slug: 'alpha', hidden: true } });
    expect(w.store.setShopHidden).toHaveBeenCalledWith('alpha', true);
  });

  it('GET matches passes pending and paging; PATCH match takes { confirmed: boolean }', async () => {
    const w = setup();
    await w.send('GET', '/api/admin/matches?pending=1');
    expect(w.store.matches).toHaveBeenCalledWith(true, 50, 0);
    await w.send('GET', '/api/admin/matches?page=2');
    expect(w.store.matches).toHaveBeenLastCalledWith(false, 50, 50);
    expect((await w.send('GET', '/api/admin/matches?pending=yes')).status).toBe(400);
    expect((await w.send('PATCH', '/api/admin/matches/7', { confirmed: 1 })).status).toBe(400);
    const res = await w.send('PATCH', '/api/admin/matches/7', { confirmed: true });
    expect(await res.json()).toEqual({ member: { id: 7, confirmed: true } });
  });
});

describe('access settings cache', () => {
  beforeEach(() => resetSiteSettingsCache());

  it('a reset during an in-flight load is not undone by that load', async () => {
    let release: (v: { value: unknown }[]) => void = () => {};
    const slow = () => new Promise<{ value: unknown }[]>((r) => (release = r));
    const first = loadSiteSettings('db', slow, 0);
    resetSiteSettingsCache();
    release([{ value: false }]);
    expect(await first).toEqual({ public: false });
    // the stale answer was not cached: the next load queries again
    expect(await loadSiteSettings('db', async () => [{ value: true }], 1)).toEqual({ public: true });
  });
});

describe('admin store on PGlite as site_admin', () => {
  let pg: PGlite;
  let store: AdminStore;

  /** Every statement runs as site_admin, so the grants of scripts/create-site-roles.ts are what is tested. */
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

  function ownerRunner(db: PGlite): SqlRunner {
    return {
      query: async (text, params) => (await db.query<Record<string, unknown>>(text, params)).rows,
      transaction: (statements) =>
        db.transaction(async (t) => {
          const out: Record<string, unknown>[][] = [];
          for (const s of statements) out.push((await t.query<Record<string, unknown>>(s.text, s.params)).rows);
          return out;
        }),
    };
  }

  beforeAll(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    pg = await PGlite.create({ dataDir: 'memory://', extensions: { pg_trgm } });
    const dir = path.resolve('db/migrations');
    for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(await readFile(path.join(dir, f), 'utf8'));
    // the grants of scripts/create-site-roles.ts
    await pg.exec(`
      create role site_admin;
      grant usage on schema public to site_admin;
      grant select on site_settings, site_products, shop_ratings, shops, reports, products, price_observations, canonical_products to site_admin;
      grant insert, update on site_settings to site_admin;
      grant update (status, admin_note, resolved_at) on reports to site_admin;
      grant update (site_hidden) on shops to site_admin;
      grant update (match_confirmed) on site_products to site_admin;
    `);
    await pg.exec(`
      insert into shops (id, slug, name, base_url, adapter, active, site_hidden) values
        (1, 'alpha', 'Alpha', 'https://alpha.example', 'woo', true, false),
        (2, 'beta', 'Beta', 'https://beta.example', 'woo', true, false);
      insert into products (id, shop_id, external_id, parent_external_id, title, category_path) values
        (10, 1, 'v1', 'G1', 'Lenovo IdeaPad', 'Computers > Laptops'),
        (11, 1, 'v2', 'G1', 'Lenovo IdeaPad', 'Computers > Laptops'),
        (20, 2, 'b1', null, 'Gizmo One', 'Gadgets > Misc'),
        (21, 2, 'b2', null, 'Gizmo Two', 'Gadgets > Misc'),
        (22, 2, 'b3', null, 'Thing', 'Stuff');
      insert into site_products (id, shop_id, group_key, title, category, rep_product_id, price_cents, verdict, canonical_id, match_method, match_confirmed, updated_at) values
        (1, 1, 'G1', 'Lenovo IdeaPad', 'laptops', 10, 70000, 'none', 100, 'title', false, now()),
        (2, 2, 'b1', 'Lenovo IdeaPad laptop', 'other', 20, 65000, 'none', 100, 'title', false, now()),
        (3, 2, 'b2', 'Gizmo Two', 'other', 21, null, 'none', 200, 'title', true, now()),
        (4, 1, 'x1', 'Gizmo 2', 'other', 22, 900, 'none', 200, 'title', true, now()),
        (5, 2, 'b3', 'Thing', 'other', 22, 100, 'none', 300, 'gtin', false, now());
      insert into reports (id, target_type, target_id, reason, message, email, ip_hash, created_at) values
        (1, 'product', 11, 'wrong-price', '<b>not html</b>', 'me@example.com', 'h', now() - interval '3 hours'),
        (2, 'shop', 2, 'other', null, null, 'h', now() - interval '2 hours'),
        (3, 'match', 4, 'wrong-match', 'Not the same', null, 'h', now() - interval '1 hour'),
        (4, 'product', 999, 'other', null, null, 'h', now());
    `);
    store = createAdminStore(adminRunner(pg));
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  it('saves settings as one row per top-level key, twice (upsert), read back the same', async () => {
    const s = clone();
    s.thresholds.raisePct = 7.5;
    s.categoryOverrides = { misc: 'tv-audio' };
    await store.saveSettings(s);
    s.public = true;
    await store.saveSettings(s);
    const { rows } = await pg.query<{ key: string }>('select key from site_settings order by key');
    expect(rows.map((r) => r.key)).toEqual(['categoryOverrides', 'phrases', 'public', 'thresholds']);
    expect(settingsFromRows(await store.settingsRows())).toEqual(s);
  });

  it('lists reports newest first with resolved target links, paged and filtered by status', async () => {
    const { items, total } = await store.reports('open', 50, 0);
    expect(total).toBe(4);
    expect(items.map((r) => r.id)).toEqual([4, 3, 2, 1]);
    expect(items.map((r) => r.target)).toEqual([
      { link: null, label: null },
      { link: '/p/4', label: 'Gizmo 2' },
      { link: '/shops/beta', label: 'Beta' },
      { link: '/p/1', label: 'Lenovo IdeaPad' },
    ]);
    expect(items[3]).toMatchObject({ targetType: 'product', targetId: 11, reason: 'wrong-price', message: '<b>not html</b>', email: 'me@example.com', status: 'open', adminNote: null, resolvedAt: null });
    expect(typeof items[3]!.createdAt).toBe('string');
    const page2 = await store.reports('open', 2, 2);
    expect(page2.items.map((r) => r.id)).toEqual([2, 1]);
    expect(page2.total).toBe(4);
  });

  it('PATCH report sets resolved_at when closed, keeps it on a note edit, clears it when reopened', async () => {
    const fixed = await store.updateReport(2, 'fixed', 'Done.');
    expect(fixed).toMatchObject({ id: 2, status: 'fixed', adminNote: 'Done.' });
    expect(fixed!.resolvedAt).not.toBeNull();
    const at = fixed!.resolvedAt;
    const noted = await store.updateReport(2, 'fixed', undefined);
    expect(noted).toMatchObject({ adminNote: 'Done.', resolvedAt: at });
    const reopened = await store.updateReport(2, 'open', null);
    expect(reopened).toMatchObject({ status: 'open', adminNote: null, resolvedAt: null });
    expect((await store.reports('open', 50, 0)).total).toBe(4);
    await store.updateReport(2, 'hidden', undefined);
    expect((await store.reports('hidden', 50, 0)).items.map((r) => r.id)).toEqual([2]);
    expect(await store.updateReport(12345, 'fixed', undefined)).toBeNull();
  });

  it('lists all shops with hidden state and hides one; unknown slug gives null', async () => {
    expect(await store.setShopHidden('beta', true)).toEqual({ slug: 'beta', hidden: true });
    expect(await store.shops()).toEqual([
      { slug: 'alpha', name: 'Alpha', active: true, hidden: false, products: 2 },
      { slug: 'beta', name: 'Beta', active: true, hidden: true, products: 3 },
    ]);
    expect(await store.setShopHidden('nope', true)).toBeNull();
    await store.setShopHidden('beta', false);
  });

  it('lists title-matched groups with pending members, and confirms a member', async () => {
    const pending = await store.matches(true, 50, 0);
    expect(pending.total).toBe(1);
    expect(pending.groups).toEqual([
      {
        canonicalId: 100,
        members: [
          { id: 1, title: 'Lenovo IdeaPad', shop: 'Alpha', shopSlug: 'alpha', priceCents: 70000, confirmed: false },
          { id: 2, title: 'Lenovo IdeaPad laptop', shop: 'Beta', shopSlug: 'beta', priceCents: 65000, confirmed: false },
        ],
      },
    ]);
    const all = await store.matches(false, 50, 0);
    expect(all.total).toBe(2);
    expect(all.groups[1]!.members.map((m) => m.priceCents)).toEqual([null, 900]);
    expect(await store.confirmMatch(1, true)).toEqual({ id: 1, confirmed: true });
    expect(await store.confirmMatch(2, true)).toEqual({ id: 2, confirmed: true });
    expect((await store.matches(true, 50, 0)).total).toBe(0);
    expect(await store.confirmMatch(999, true)).toBeNull();
  });

  it('confirms only title-matched rows: a GTIN row is not found and stays unchanged', async () => {
    expect(await store.confirmMatch(5, true)).toBeNull();
    const { rows } = await pg.query<{ match_confirmed: boolean }>('select match_confirmed from site_products where id = 5');
    expect(rows[0]!.match_confirmed).toBe(false);
  });

  it('lists the most common products.category_path among site_products in category other', async () => {
    expect(await store.unmappedCategories()).toEqual([
      { path: 'Gadgets > Misc', count: 2 },
      { path: 'Stuff', count: 2 },
    ]);
  });

  it('site_admin cannot change anything else (grants)', async () => {
    const tryAs = (text: string) =>
      pg.transaction(async (t) => {
        await t.query('set local role site_admin');
        await t.query(text);
      });
    await expect(tryAs(`update reports set message = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(tryAs(`update shops set name = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(tryAs(`update site_products set price_cents = 1`)).rejects.toThrow(/permission denied/);
    await expect(tryAs(`delete from site_settings`)).rejects.toThrow(/permission denied/);
  });

  it('a phrase saved through PUT shows on GET /api/home once the cache is bypassed', async () => {
    const deps = { store: () => store, invalidateSettings: () => {} };
    const s = clone();
    for (const slot of Object.keys(s.phrases) as (keyof SiteSettings['phrases'])[]) s.phrases[slot] = ['Freshly *edited* line.'];
    const put = new Request(`${SITE}/api/admin/settings`, {
      method: 'PUT',
      headers: { authorization: ADMIN_AUTH, 'content-type': 'application/json', origin: SITE },
      body: JSON.stringify(s),
    });
    expect((await handleAdmin(put, baseEnv, new URL(put.url), deps)).status).toBe(200);
    const data = createData(ownerRunner(pg));
    const get = new Request(`${SITE}/api/home`);
    const home = await handleApi(get, baseEnv, new URL(get.url), { data: () => data, cache: () => null });
    expect(home.status).toBe(200);
    const body = (await home.json()) as { phrases: SiteSettings['phrases'] };
    expect(body.phrases.morning).toEqual(['Freshly *edited* line.']);
  });
});
