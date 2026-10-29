// POST /api/shop-suggestions (web/worker/suggestions.ts): visitors suggest a shop on /shops.
// Unit tests use a fake store; the last block runs the real SQL on PGlite as the site_reporter role.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { REASON_TEXT, SCOPE_NOTE } from '../../src/shop-requests/reasons.js';
import { type ApiDeps, handleApi } from '../../web/worker/api.js';
import type { ResponseCache } from '../../web/worker/cache.js';
import type { Env } from '../../web/worker/env.js';
import type { WriteRunner } from '../../web/worker/reports.js';
import {
  answerFor,
  createSuggestionStore,
  type KnownRequest,
  type KnownShop,
  MAX_VISITOR_QUEUED,
  SUGGESTIONS_PER_DAY,
  type SuggestionStore,
} from '../../web/worker/suggestions.js';

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

const shop = (over: Partial<KnownShop>): KnownShop => ({ slug: 'klikk', name: 'Klikk', baseUrl: 'https://www.klikk.com.mt', active: true, hidden: false, reason: null, ...over });
const req = (over: Partial<KnownRequest>): KnownRequest => ({ origin: 'https://new.example.mt', status: 'pending', reason: null, ...over });
const unavailable = (reason: keyof typeof REASON_TEXT) => ({ outcome: 'unavailable', reason, ...REASON_TEXT[reason], scope: SCOPE_NOTE });

describe('answerFor', () => {
  it('a live shop is listed, matched with or without www.', () => {
    expect(answerFor('klikk.com.mt', [shop({})], [])).toEqual({ outcome: 'listed', shop: { slug: 'klikk', name: 'Klikk' } });
    expect(answerFor('www.klikk.com.mt', [shop({ baseUrl: 'https://klikk.com.mt' })], [])).toMatchObject({ outcome: 'listed' });
  });

  it('a switched-off shop gives its public reason; without one, or hidden, it is only known', () => {
    expect(answerFor('decathlon.mt', [shop({ baseUrl: 'https://www.decathlon.mt', active: false, reason: 'bot_protection' })], [])).toEqual(unavailable('bot_protection'));
    expect(answerFor('agenda.mt', [shop({ baseUrl: 'https://agenda.mt', active: false })], [])).toEqual({ outcome: 'known' });
    expect(answerFor('klikk.com.mt', [shop({ hidden: true })], [])).toEqual({ outcome: 'known' });
    // a code the Worker does not know is never shown
    expect(answerFor('agenda.mt', [shop({ baseUrl: 'https://agenda.mt', active: false, reason: 'something' })], [])).toEqual({ outcome: 'known' });
  });

  it('a request: waiting or running is checking, rejected is declined, otherwise its reason', () => {
    expect(answerFor('new.example.mt', [], [req({})])).toEqual({ outcome: 'checking' });
    expect(answerFor('new.example.mt', [], [req({ status: 'checking' })])).toEqual({ outcome: 'checking' });
    expect(answerFor('new.example.mt', [], [req({ status: 'rejected' })])).toEqual(unavailable('declined'));
    expect(answerFor('new.example.mt', [], [req({ status: 'blocked', reason: 'robots' })])).toEqual(unavailable('robots'));
    expect(answerFor('new.example.mt', [], [req({ status: 'failed', reason: null })])).toEqual({ outcome: 'known' });
  });

  it('the newest request counts (the list comes newest first)', () => {
    expect(answerFor('new.example.mt', [], [req({ status: 'pending' }), req({ status: 'failed', reason: 'not_found' })])).toEqual({ outcome: 'checking' });
  });

  it('a shop that failed its test scrape (inactive, no public reason) answers with the request reason', () => {
    const s = shop({ baseUrl: 'https://thin.example.mt', active: false });
    expect(answerFor('thin.example.mt', [s], [req({ origin: 'https://thin.example.mt', status: 'failed', reason: 'not_readable' })])).toEqual(unavailable('not_readable'));
  });

  it('an unknown host is new', () => {
    expect(answerFor('other.example.mt', [shop({})], [req({})])).toBeNull();
  });
});

function fakeStore(known: { shops?: KnownShop[]; requests?: KnownRequest[] } = {}, insert: SuggestionStore['insert'] = async () => ({ ok: true })) {
  const store = { known: vi.fn(async () => ({ shops: known.shops ?? [], requests: known.requests ?? [] })), insert: vi.fn(insert) };
  return store;
}

function setup(store: ReturnType<typeof fakeStore>, opts: { env?: Partial<Env>; verify?: typeof fetch } = {}) {
  const cache: ResponseCache = { match: vi.fn(async () => undefined), put: vi.fn(async () => {}) };
  const deps: ApiDeps = {
    data: () => {
      throw new Error('reads must not run');
    },
    cache: () => cache,
    suggestions: { store: () => store, fetch: opts.verify },
  };
  const env = { ...baseEnv, ...opts.env };
  return {
    cache,
    send: (body: unknown, init: { headers?: Record<string, string>; method?: string } = {}) => {
      const req = new Request(`${SITE}/api/shop-suggestions`, {
        method: init.method ?? 'POST',
        headers: { 'content-type': 'application/json', origin: SITE, 'cf-connecting-ip': '203.0.113.7', ...init.headers },
        body: init.method === 'GET' ? undefined : JSON.stringify(body),
      });
      return handleApi(req, env, new URL(req.url), deps);
    },
  };
}

describe('POST /api/shop-suggestions', () => {
  it('queues a new address as its origin with a salted hash of the network; a visitor name is ignored', async () => {
    const store = fakeStore();
    const res = await setup(store).send({ url: '  Shop.Example.mt/some/page ', name: ' My  Shop ' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ outcome: 'queued' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(store.insert).toHaveBeenCalledWith({ origin: 'https://shop.example.mt', ipHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('answers a known shop at once and stores nothing', async () => {
    const store = fakeStore({ shops: [shop({ baseUrl: 'https://www.decathlon.mt', active: false, reason: 'bot_protection' })] });
    const res = await setup(store).send({ url: 'decathlon.mt' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(unavailable('bot_protection'));
    expect(store.insert).not.toHaveBeenCalled();
  });

  it('refuses a bad address with its problem, before any database work', async () => {
    const store = fakeStore();
    for (const [url, reason] of [
      ['', 'empty'],
      ['http://10.0.0.1', 'ip'],
      ['https://user:pw@shop.example.mt', 'credentials'],
      ['https://shop.example.mt:8080', 'port'],
      ['localhost', 'host'],
    ] as const) {
      const res = await setup(store).send({ url });
      expect(res.status, url).toBe(400);
      expect(await res.json(), url).toEqual({ error: 'url', reason });
    }
    expect((await setup(store).send({ url: 42 })).status).toBe(400);
    expect(store.known).not.toHaveBeenCalled();
  });

  it('keeps the shared write checks: method, Origin, content type', async () => {
    const store = fakeStore();
    const s = setup(store);
    expect((await s.send(null, { method: 'GET' })).status).toBe(405);
    expect((await s.send({ url: 'shop.example.mt' }, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await s.send({ url: 'shop.example.mt' }, { headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect(store.known).not.toHaveBeenCalled();
  });

  it('a network over its daily limit gets 429 with retry-after; a full queue 503; a parallel duplicate is checking', async () => {
    const limited = await setup(fakeStore({}, async () => ({ ok: false, limit: 'network', retryAfter: 7200 }))).send({ url: 'a.example.mt' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('7200');
    expect((await setup(fakeStore({}, async () => ({ ok: false, limit: 'queue' }))).send({ url: 'a.example.mt' })).status).toBe(503);
    const dup = await setup(fakeStore({}, async () => ({ ok: false, limit: 'duplicate' }))).send({ url: 'a.example.mt' });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual({ outcome: 'checking' });
  });

  it('with a Turnstile secret, a missing or failed token is refused before any database work', async () => {
    const store = fakeStore();
    const verify = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 }));
    const s = setup(store, { env: { TURNSTILE_SECRET: 'ts' }, verify: verify as unknown as typeof fetch });
    expect((await s.send({ url: 'shop.example.mt' })).status).toBe(400);
    expect((await s.send({ url: 'shop.example.mt', turnstileToken: 'tok' })).status).toBe(400);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(store.known).not.toHaveBeenCalled();
  });

  it('fails closed without IP_SALT and is never cached', async () => {
    const store = fakeStore();
    const s = setup(store, { env: { IP_SALT: '' } });
    await expect(s.send({ url: 'shop.example.mt' })).rejects.toThrow(/IP_SALT/);
    const ok = setup(store);
    await ok.send({ url: 'shop.example.mt' });
    expect(ok.cache.put).not.toHaveBeenCalled();
  });
});

describe('suggestion store on PGlite as site_reporter', () => {
  let pg: PGlite;
  let store: SuggestionStore;

  /** Every transaction runs as site_reporter, so the grants of migration 018 and create-site-roles.ts are what is tested. */
  function runner(db: PGlite): WriteRunner {
    return {
      transaction: (statements) =>
        db.transaction(async (tx) => {
          await tx.query('set local role site_reporter');
          const out: Record<string, unknown>[][] = [];
          for (const s of statements) out.push((await tx.query<Record<string, unknown>>(s.text, s.params)).rows);
          return out;
        }),
    };
  }
  const asReporter = (text: string) => runner(pg).transaction([{ text, params: [] }]);

  beforeAll(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    pg = await PGlite.create({ dataDir: 'memory://', extensions: { pg_trgm } });
    // the role exists before the migrations, as in production, so 018 grants it its columns
    await pg.exec('create role site_reporter; grant usage on schema public to site_reporter;');
    const dir = path.resolve('db/migrations');
    for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(await readFile(path.join(dir, f), 'utf8'));
    await pg.exec(`
      insert into shops (slug, name, base_url, adapter, active, notes, unavailable_reason) values
        ('klikk', 'Klikk', 'https://www.klikk.com.mt', 'shopify', true, null, null),
        ('decathlon', 'Decathlon', 'https://www.decathlon.mt', 'html', false, 'Cloudflare challenge (internal note)', 'bot_protection');
      insert into shop_requests (origin, status, error, reason) values ('https://forestals.com', 'blocked', 'robots.txt blocks the home page', 'robots');
    `);
    store = createSuggestionStore(runner(pg));
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  it('reads the public columns of shops and requests', async () => {
    const known = await store.known();
    expect(known.shops).toEqual([
      { slug: 'klikk', name: 'Klikk', baseUrl: 'https://www.klikk.com.mt', active: true, hidden: false, reason: null },
      { slug: 'decathlon', name: 'Decathlon', baseUrl: 'https://www.decathlon.mt', active: false, hidden: false, reason: 'bot_protection' },
    ]);
    expect(known.requests).toEqual([{ origin: 'https://forestals.com', status: 'blocked', reason: 'robots' }]);
  });

  it('cannot read the owner notes, the raw error or the check details, nor change a request', async () => {
    await expect(asReporter('select notes from shops')).rejects.toThrow(/permission denied/);
    await expect(asReporter('select error from shop_requests')).rejects.toThrow(/permission denied/);
    await expect(asReporter('select config from shops')).rejects.toThrow(/permission denied/);
    await expect(asReporter(`update shop_requests set status = 'pending'`)).rejects.toThrow(/permission denied/);
    await expect(asReporter(`insert into shop_requests (origin, status) values ('https://x.example.mt', 'active')`)).rejects.toThrow(/permission denied/);
    await expect(asReporter(`insert into shop_requests (origin, display_name) values ('https://x.example.mt', 'Free money')`)).rejects.toThrow(/permission denied/);
  });

  it('inserts a visitor request as pending, then refuses the same shop with or without www.', async () => {
    expect(await store.insert({ origin: 'https://one.example.mt', ipHash: 'h1' })).toEqual({ ok: true });
    const { rows } = await pg.query<Record<string, unknown>>(`select origin, display_name, status, source, ip_hash from shop_requests where origin = 'https://one.example.mt'`);
    expect(rows).toEqual([{ origin: 'https://one.example.mt', display_name: null, status: 'pending', source: 'visitor', ip_hash: 'h1' }]);
    expect(await store.insert({ origin: 'https://www.one.example.mt', ipHash: 'h9' })).toEqual({ ok: false, limit: 'duplicate' });
  });

  it(`allows ${SUGGESTIONS_PER_DAY} per network per day, ignoring older ones, with a retry time`, async () => {
    await pg.exec(`insert into shop_requests (origin, source, ip_hash, status, requested_at) values ('https://old.example.mt', 'visitor', 'h2', 'failed', now() - interval '25 hours')`);
    await pg.exec(`insert into shop_requests (origin, source, ip_hash, status, requested_at) values ('https://older.example.mt', 'visitor', 'h2', 'failed', now() - interval '20 hours')`);
    expect(await store.insert({ origin: 'https://two.example.mt', ipHash: 'h2' })).toEqual({ ok: true });
    expect(await store.insert({ origin: 'https://three.example.mt', ipHash: 'h2' })).toEqual({ ok: true });
    const fourth = await store.insert({ origin: 'https://four.example.mt', ipHash: 'h2' });
    expect(fourth).toMatchObject({ ok: false, limit: 'network' });
    // the oldest counted one (20 hours ago) leaves the window in about 4 hours
    const retry = (fourth as { retryAfter: number }).retryAfter;
    expect(retry).toBeGreaterThanOrEqual(4 * 3600 - 5);
    expect(retry).toBeLessThanOrEqual(4 * 3600 + 1);
    expect((await pg.query(`select 1 from shop_requests where origin = 'https://four.example.mt'`)).rows).toHaveLength(0);
  });

  it(`at most ${MAX_VISITOR_QUEUED} visitor suggestions wait at once; the owner's own requests are not counted against visitors`, async () => {
    const waiting = Number((await pg.query<{ n: number }>(`select count(*)::int as n from shop_requests where source = 'visitor' and status in ('pending', 'checking')`)).rows[0]!.n);
    for (let i = waiting; i < MAX_VISITOR_QUEUED; i++) {
      expect(await store.insert({ origin: `https://fill${i}.example.mt`, ipHash: `fill${i}` })).toEqual({ ok: true });
    }
    expect(await store.insert({ origin: 'https://over.example.mt', ipHash: 'h-over' })).toEqual({ ok: false, limit: 'queue' });
    await pg.exec(`update shop_requests set status = 'failed' where origin = 'https://fill9.example.mt'`);
    expect(await store.insert({ origin: 'https://over.example.mt', ipHash: 'h-over' })).toEqual({ ok: true });
  });

  it('the whole queue cap holds too', async () => {
    await pg.exec(`update shop_requests set status = 'failed' where source = 'visitor'`);
    const values = Array.from({ length: 20 }, (_, i) => `('https://admin${i}.example.mt')`).join(', ');
    await pg.exec(`insert into shop_requests (origin) values ${values}`);
    expect(await store.insert({ origin: 'https://late.example.mt', ipHash: 'h-late' })).toEqual({ ok: false, limit: 'queue' });
  });
});
