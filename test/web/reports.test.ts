// POST /api/reports (web/worker/reports.ts): the site's only public write path.
// Unit tests use a fake store; the last block runs the real SQL on PGlite as the site_reporter role.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ApiDeps, handleApi } from '../../web/worker/api.js';
import type { ResponseCache } from '../../web/worker/cache.js';
import type { Data } from '../../web/worker/data.js';
import type { Env } from '../../web/worker/env.js';
import { type Bindings, createHandler } from '../../web/worker/index.js';
import { createReportStore, type NewReport, type ReportStore, type WriteRunner } from '../../web/worker/reports.js';

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

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** In-memory store with the real rate limit rule: at most `limit` reports per ip hash. */
function fakeStore() {
  const rows: NewReport[] = [];
  const store: ReportStore = {
    insertLimited: vi.fn(async (r: NewReport, limit: number) => {
      if (rows.filter((x) => x.ipHash === r.ipHash).length >= limit) return { ok: false as const, retryAfter: 1800 };
      rows.push(r);
      return { ok: true as const };
    }),
  };
  return { rows, store };
}

function setup(opts: { env?: Partial<Env>; verify?: typeof fetch } = {}) {
  const { rows, store } = fakeStore();
  const cache: ResponseCache = { match: vi.fn(async () => undefined), put: vi.fn(async () => {}) };
  const deps: ApiDeps = {
    data: () => {
      throw new Error('reads must not run');
    },
    cache: () => cache,
    reports: { store: () => store, fetch: opts.verify },
  };
  const env = { ...baseEnv, ...opts.env };
  return {
    rows,
    store,
    cache,
    /** a null header value leaves that header out */
    send: (body: unknown, init: { headers?: Record<string, string | null>; method?: string; url?: string; raw?: string | ReadableStream } = {}) => {
      const merged = { 'content-type': 'application/json', origin: SITE, 'cf-connecting-ip': '203.0.113.7', ...init.headers };
      const headers = Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== null));
      const req = new Request(init.url ?? `${SITE}/api/reports`, {
        method: init.method ?? 'POST',
        headers,
        body: init.method === 'GET' || init.method === 'HEAD' ? undefined : (init.raw ?? JSON.stringify(body)),
        // streams need duplex in Node
        ...(init.raw instanceof ReadableStream ? { duplex: 'half' } : {}),
      } as RequestInit);
      return handleApi(req, env, new URL(req.url), deps);
    },
  };
}

const valid = { targetType: 'product', targetId: 70, reason: 'wrong-price', message: '  The price is €799 not €709.  ', email: '' };

describe('POST /api/reports', () => {
  it('inserts a valid report and answers 201 { ok: true }, never cached', async () => {
    const w = setup();
    const res = await w.send(valid);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(w.rows).toEqual([
      { targetType: 'product', targetId: 70, reason: 'wrong-price', message: 'The price is €799 not €709.', email: null, ipHash: sha('salt203.0.113.7') },
    ]);
    expect(w.store.insertLimited).toHaveBeenCalledWith(expect.anything(), 5);
    expect(w.cache.match).not.toHaveBeenCalled();
    expect(w.cache.put).not.toHaveBeenCalled();
  });

  it('accepts shop and match targets, no message and a trimmed email', async () => {
    const w = setup();
    expect((await w.send({ targetType: 'shop', targetId: 3, reason: 'other' })).status).toBe(201);
    expect((await w.send({ targetType: 'match', targetId: 9, reason: 'wrong-match', message: '   ', email: ' me@example.com ' })).status).toBe(201);
    expect(w.rows.map((r) => [r.targetType, r.targetId, r.message, r.email])).toEqual([
      ['shop', 3, null, null],
      ['match', 9, null, 'me@example.com'],
    ]);
  });

  it('rejects a message over 1000 characters with 400; 1000 after trimming is fine', async () => {
    const w = setup();
    const long = await w.send({ ...valid, message: 'x'.repeat(1001) });
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ error: 'message' });
    expect((await w.send({ ...valid, message: `  ${'x'.repeat(1000)}  ` })).status).toBe(201);
    expect(w.rows).toHaveLength(1);
  });

  it('gives 429 to the 6th report within an hour from one IP, not to another IP', async () => {
    const w = setup();
    for (let i = 0; i < 5; i++) expect((await w.send(valid)).status).toBe(201);
    const sixth = await w.send(valid);
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ error: 'rate limited' });
    expect(sixth.headers.get('retry-after')).toBe('1800');
    expect(sixth.headers.get('cache-control')).toBe('no-store');
    expect((await w.send(valid, { headers: { 'cf-connecting-ip': '198.51.100.1' } })).status).toBe(201);
    expect(w.rows).toHaveLength(6);
  });

  it('rejects an email that does not look like one', async () => {
    const w = setup();
    for (const email of ['x', 'a@b', 'a b@c.de', `${'a'.repeat(250)}@b.cd`, 5]) {
      const res = await w.send({ ...valid, email });
      expect(res.status, String(email)).toBe(400);
      expect(await res.json()).toEqual({ error: 'email' });
    }
    expect(w.rows).toHaveLength(0);
  });

  it('rejects a bad target type, target id or reason', async () => {
    const w = setup();
    const cases: [Record<string, unknown>, string][] = [
      [{ targetType: 'user' }, 'targetType'],
      [{ targetType: undefined }, 'targetType'],
      [{ targetId: '70' }, 'targetId'],
      [{ targetId: 0 }, 'targetId'],
      [{ targetId: -3 }, 'targetId'],
      [{ targetId: 1.5 }, 'targetId'],
      [{ targetId: 2 ** 53 }, 'targetId'],
      [{ reason: 'spam' }, 'reason'],
      [{ reason: undefined }, 'reason'],
      [{ message: 42 }, 'message'],
    ];
    for (const [patch, field] of cases) {
      const res = await w.send({ ...valid, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(await res.json()).toEqual({ error: field });
    }
    expect(w.rows).toHaveLength(0);
  });

  it('rejects a body that is not a JSON object', async () => {
    const w = setup();
    for (const raw of ['{', '[]', 'null', '"x"']) {
      const res = await w.send(null, { raw });
      expect(res.status, raw).toBe(400);
      expect(await res.json()).toEqual({ error: 'body' });
    }
  });

  it('needs content-type application/json', async () => {
    const w = setup();
    const res = await w.send(valid, { headers: { 'content-type': 'text/plain' } });
    expect(res.status).toBe(415);
    expect((await w.send(valid, { headers: { 'content-type': 'application/json; charset=utf-8' } })).status).toBe(201);
  });

  it('needs an Origin of SITE_ORIGIN or the request URL itself', async () => {
    const w = setup({ env: { SITE_ORIGIN: 'https://bf.example/' } });
    for (const origin of [null, '', 'https://evil.example', 'null', 'https://bf.example.evil.example', 'http://bf.example']) {
      const res = await w.send(valid, { headers: { origin } });
      expect(res.status, String(origin)).toBe(403);
    }
    expect((await w.send(valid, { headers: { origin: 'https://bf.example' } })).status).toBe(201);
    // the workers.dev name: the request's own origin
    expect((await w.send(valid, { url: 'https://bf.someone.workers.dev/api/reports', headers: { origin: 'https://bf.someone.workers.dev' } })).status).toBe(201);
    expect(w.rows).toHaveLength(2);
  });

  it('rejects a body over 8 KB with 413, by header and by actual size', async () => {
    const w = setup();
    const declared = await w.send(valid, { headers: { 'content-length': '9000' } });
    expect(declared.status).toBe(413);
    const bytes = new TextEncoder().encode(JSON.stringify({ ...valid, pad: 'x'.repeat(9000) }));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 1000) c.enqueue(bytes.slice(i, i + 1000));
        c.close();
      },
    });
    const streamed = await w.send(null, { raw: stream });
    expect(streamed.status).toBe(413);
    expect(w.rows).toHaveLength(0);
  });

  it('ignores unknown keys', async () => {
    const w = setup();
    expect((await w.send({ ...valid, status: 'fixed', id: 1 })).status).toBe(201);
    expect(Object.keys(w.rows[0]!).sort()).toEqual(['email', 'ipHash', 'message', 'reason', 'targetId', 'targetType']);
  });

  it('hashes into one fixed bucket when cf-connecting-ip is missing', async () => {
    const w = setup();
    const req = new Request(`${SITE}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json', origin: SITE }, body: JSON.stringify(valid) });
    const deps: ApiDeps = { data: () => ({}) as Data, cache: () => null, reports: { store: () => w.store } };
    expect((await handleApi(req, baseEnv, new URL(req.url), deps)).status).toBe(201);
    expect(w.rows[0]!.ipHash).toBe(sha('saltunknown'));
  });

  it('removes control characters and lone surrogates from the message', async () => {
    const w = setup();
    expect((await w.send({ ...valid, message: 'a\u0000b\nc\ud800d' })).status).toBe(201);
    expect(w.rows[0]!.message).toBe('ab\nc�d');
  });

  it('answers other methods with 405 and allow: POST', async () => {
    const w = setup();
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await w.send(valid, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });
});

describe('Turnstile', () => {
  const ok = (success: boolean) => vi.fn(async () => new Response(JSON.stringify({ success }), { headers: { 'content-type': 'application/json' } }));

  it('is not asked when TURNSTILE_SECRET is unset', async () => {
    const verify = ok(false);
    const w = setup({ verify: verify as unknown as typeof fetch });
    expect((await w.send(valid)).status).toBe(201);
    expect(verify).not.toHaveBeenCalled();
  });

  it('needs a token when the secret is set', async () => {
    const verify = ok(true);
    const w = setup({ env: { TURNSTILE_SECRET: 'ts-secret' }, verify: verify as unknown as typeof fetch });
    const res = await w.send(valid);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'turnstileToken' });
    expect(verify).not.toHaveBeenCalled();
    expect(w.rows).toHaveLength(0);
  });

  it('verifies the token with siteverify and stores the report when it passes', async () => {
    const verify = ok(true);
    const w = setup({ env: { TURNSTILE_SECRET: 'ts-secret' }, verify: verify as unknown as typeof fetch });
    expect((await w.send({ ...valid, turnstileToken: 'tok' })).status).toBe(201);
    expect(verify).toHaveBeenCalledTimes(1);
    const [url, init] = verify.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(init.method).toBe('POST');
    const form = init.body as URLSearchParams;
    expect(form.get('secret')).toBe('ts-secret');
    expect(form.get('response')).toBe('tok');
    expect(form.get('remoteip')).toBe('203.0.113.7');
  });

  it('rejects a token that fails verification', async () => {
    const w = setup({ env: { TURNSTILE_SECRET: 'ts-secret' }, verify: ok(false) as unknown as typeof fetch });
    const res = await w.send({ ...valid, turnstileToken: 'bad' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'turnstileToken' });
    expect(w.rows).toHaveLength(0);
  });
});

describe('through the worker handler', () => {
  it('runs behind access control and adds the security headers', async () => {
    const { store, rows } = fakeStore();
    const env: Bindings = { ...baseEnv, ASSETS: { fetch: async () => new Response('') } };
    const handler = createHandler({
      loadSettings: async () => ({ public: true }),
      api: { data: () => ({}) as Data, cache: () => null, reports: { store: () => store } },
    });
    const res = await handler.fetch(
      new Request(`${SITE}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json', origin: SITE }, body: JSON.stringify(valid) }),
      env,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(rows).toHaveLength(1);
  });
});

describe('report store on PGlite as site_reporter', () => {
  let pg: PGlite;
  let store: ReportStore;

  /** Every transaction runs as site_reporter, so the grants of scripts/create-site-roles.ts are what is tested. */
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

  const report = (ipHash: string, extra: Partial<NewReport> = {}): NewReport => ({
    targetType: 'product',
    targetId: 70,
    reason: 'wrong-price',
    message: 'Shown as €799.',
    email: 'me@example.com',
    ipHash,
    ...extra,
  });

  beforeAll(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    pg = await PGlite.create({ dataDir: 'memory://', extensions: { pg_trgm } });
    const dir = path.resolve('db/migrations');
    for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(await readFile(path.join(dir, f), 'utf8'));
    // the grants of scripts/create-site-roles.ts
    await pg.exec(`
      create role site_reporter;
      grant usage on schema public to site_reporter;
      grant insert on reports to site_reporter;
      grant select (ip_hash, created_at) on reports to site_reporter;
      grant usage on sequence reports_id_seq to site_reporter;
    `);
    store = createReportStore(runner(pg));
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  it('inserts with the reporter grants and stores every field', async () => {
    expect(await store.insertLimited(report('h1', { targetType: 'match', targetId: 9_007_199_254_740_991 }), 5)).toEqual({ ok: true });
    const { rows } = await pg.query<Record<string, unknown>>(`select target_type, target_id::text as target_id, reason, message, email, ip_hash, status from reports`);
    expect(rows).toEqual([
      { target_type: 'match', target_id: '9007199254740991', reason: 'wrong-price', message: 'Shown as €799.', email: 'me@example.com', ip_hash: 'h1', status: 'open' },
    ]);
  });

  it('stores null message and email', async () => {
    expect(await store.insertLimited(report('h2', { message: null, email: null }), 5)).toEqual({ ok: true });
    const { rows } = await pg.query(`select message, email from reports where ip_hash = 'h2'`);
    expect(rows).toEqual([{ message: null, email: null }]);
  });

  it('allows 5 per hour per ip hash, refuses the 6th with a retry time, ignores older rows', async () => {
    await pg.exec(`insert into reports (target_type, target_id, ip_hash, created_at) values
      ('product', 1, 'h3', now() - interval '61 minutes'), ('product', 1, 'h3', now() - interval '2 hours')`);
    await pg.exec(`insert into reports (target_type, target_id, ip_hash, created_at) values ('product', 1, 'h3', now() - interval '50 minutes')`);
    for (let i = 0; i < 4; i++) expect(await store.insertLimited(report('h3'), 5)).toEqual({ ok: true });
    const sixth = await store.insertLimited(report('h3'), 5);
    expect(sixth.ok).toBe(false);
    // the oldest counted row (50 minutes ago) leaves the window in about 10 minutes
    const retry = (sixth as { retryAfter: number }).retryAfter;
    expect(retry).toBeGreaterThanOrEqual(595);
    expect(retry).toBeLessThanOrEqual(601);
    const { rows } = await pg.query<{ n: number }>(`select count(*)::int as n from reports where ip_hash = 'h3' and created_at > now() - interval '1 hour'`);
    expect(rows[0]!.n).toBe(5);
    expect(await store.insertLimited(report('h4'), 5)).toEqual({ ok: true });
  });

  it('the reporter role cannot read report contents', async () => {
    await expect(
      pg.transaction(async (tx) => {
        await tx.query('set local role site_reporter');
        await tx.query('select email from reports');
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
