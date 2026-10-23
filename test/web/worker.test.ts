import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';
import type { Data } from '../../web/worker/data.js';
import { type Bindings, createHandler } from '../../web/worker/index.js';

const PAGE = '<!doctype html><html><head><script>theme()</script><script type="module" src="/assets/a.js"></script></head></html>';

function setup(opts: { public: boolean; assets?: (req: Request) => Promise<Response> }) {
  const assets = vi.fn(
    opts.assets ??
      (async (req: Request) =>
        new URL(req.url).pathname.endsWith('.js')
          ? new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } })
          : new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', etag: '"x"' } })),
  );
  const env: Bindings = {
    DATABASE_URL: 'postgres://ro@example/db',
    REPORTER_DATABASE_URL: 'postgres://reporter@example/db',
    ADMIN_DATABASE_URL: 'postgres://admin@example/db',
    SITE_PASSWORD: 'site-secret',
    ADMIN_PASSWORD: 'admin-secret',
    SITE_ORIGIN: 'https://guide.example',
    IP_SALT: 'salt',
    ASSETS: { fetch: assets },
  };
  const handler = createHandler({ loadSettings: async () => ({ public: opts.public }) });
  return { assets, fetch: (path: string, password?: string) => handler.fetch(get(path, password), env) };
}

describe('API caching follows the access mode (M1)', () => {
  it('a private site answers API reads with private, max-age=600', async () => {
    const env = { DATABASE_URL: 'x', SITE_PASSWORD: 'site-secret', ADMIN_PASSWORD: 'admin-secret' } as Bindings;
    const data = { shops: async () => [], settings: async () => DEFAULT_SETTINGS } as unknown as Data;
    for (const pub of [false, true]) {
      const handler = createHandler({ loadSettings: async () => ({ public: pub }), api: { data: () => data, cache: () => null } });
      const res = await handler.fetch(get('/api/shops', 'site-secret'), env);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe(pub ? 'public, max-age=600' : 'private, max-age=600');
    }
  });
});

function get(path: string, password?: string): Request {
  const headers: Record<string, string> = {};
  if (password) headers.authorization = 'Basic ' + btoa(`u:${password}`);
  return new Request('https://guide.example' + path, { headers });
}

/** Lets the 750 ms deny delay pass under fake timers. */
async function settle(pending: Promise<Response>): Promise<Response> {
  let done = false;
  void pending.then(() => (done = true));
  for (let i = 0; i < 1000 && !done && vi.getTimerCount() === 0; i++) await new Promise((r) => setImmediate(r));
  await vi.advanceTimersByTimeAsync(750);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('worker fetch handler', () => {
  it('runs access control before assets and the API while private', async () => {
    const w = setup({ public: false });
    for (const path of ['/', '/assets/a.js', '/api/deals']) {
      const res = await settle(w.fetch(path));
      expect(res.status, path).toBe(401);
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
    expect(w.assets).not.toHaveBeenCalled();
  });

  it('rejects admin paths before the API even in public mode', async () => {
    const w = setup({ public: true });
    expect((await settle(w.fetch('/api/admin/settings', 'site-secret'))).status).toBe(401);
    expect((await w.fetch('/api//admin/settings', 'admin-secret')).status).toBe(404);
    expect(w.assets).not.toHaveBeenCalled();
  });

  it('serves HTML with a nonce that matches the CSP nonce', async () => {
    const w = setup({ public: false });
    const res = await w.fetch('/shops/abc', 'site-secret');
    expect(res.status).toBe(200);
    expect(w.assets).toHaveBeenCalledTimes(1);
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    const html = await res.text();
    const nonces = [...html.matchAll(/<script nonce="([^"]+)"/g)].map((m) => m[1]);
    expect(nonces).toEqual([nonce, nonce]);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('leaves non-HTML assets without a nonce and drops x-robots-tag when public', async () => {
    const w = setup({ public: true });
    const res = await w.fetch('/assets/a.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');
    expect(res.headers.get('content-security-policy')).not.toContain('nonce-');
    expect(res.headers.get('x-robots-tag')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const w = setup({ public: true });
    const res = await w.fetch('/api/nothing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('turns a thrown error into the generic 500', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = setup({
      public: true,
      assets: async () => {
        throw new Error('secret detail from the asset layer');
      },
    });
    const res = await w.fetch('/');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    err.mockRestore();
  });
});

describe('GET /img/<sha256>.webp (our photo copies in R2)', () => {
  const SHA = '0123456789abcdef'.repeat(4);
  const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

  function photoSetup(pub: boolean) {
    const object = () => ({ size: WEBP.length, httpEtag: '"etag-1"', body: new Response(WEBP).body });
    const bucket = {
      get: vi.fn(async (key: string) => (key === `img/${SHA}.webp` ? object() : null)),
      head: vi.fn(async (key: string) => (key === `img/${SHA}.webp` ? { size: WEBP.length, httpEtag: '"etag-1"' } : null)),
    };
    const assets = vi.fn(async () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const env = { SITE_PASSWORD: 'site-secret', ADMIN_PASSWORD: 'admin-secret', ASSETS: { fetch: assets }, BUCKET: bucket } as unknown as Bindings;
    const handler = createHandler({ loadSettings: async () => ({ public: pub }) });
    const fetch = (path: string, init: { password?: string; method?: string } = {}) => {
      const req = get(path, init.password);
      return handler.fetch(init.method ? new Request(req, { method: init.method }) : req, env);
    };
    return { bucket, assets, fetch };
  }

  it('streams the stored copy as image/webp, cached for a year, nosniff', async () => {
    const w = photoSetup(true);
    const res = await w.fetch(`/img/${SHA}.webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('etag')).toBe('"etag-1"');
    expect(res.headers.get('content-security-policy')).toContain("img-src 'self' data:");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(WEBP);
    expect(w.bucket.get).toHaveBeenCalledWith(`img/${SHA}.webp`);
    expect(w.assets).not.toHaveBeenCalled();
  });

  it('answers HEAD without a body', async () => {
    const w = photoSetup(true);
    const res = await w.fetch(`/img/${SHA}.webp`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(WEBP.length));
    expect(await res.text()).toBe('');
    expect(w.bucket.get).not.toHaveBeenCalled();
  });

  it('gives 404 for anything that is not exactly 64 lowercase hex + .webp, without touching the bucket', async () => {
    const w = photoSetup(true);
    for (const path of [
      '/img', '/img/', `/img/${SHA.toUpperCase()}.webp`, `/img/${SHA.slice(1)}.webp`, `/img/${SHA}0.webp`, `/img/${SHA}.png`,
      `/img/${SHA}.webp/`, `/img/${SHA}.WEBP`, `/IMG/${SHA}.webp`, `/%69mg/${SHA}.webp`,
      `/img//${SHA}.webp`, `/img/${SHA}%2ewebp`, `/img/sub/${SHA}.webp`,
    ]) {
      const res = await w.fetch(path);
      expect(res.status, path).toBe(404);
    }
    expect(w.bucket.get).not.toHaveBeenCalled();
    expect(w.assets).not.toHaveBeenCalled();
  });

  it('gives 404 for a key that is not stored', async () => {
    const w = photoSetup(true);
    const res = await w.fetch(`/img/${'f'.repeat(64)}.webp`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses other methods', async () => {
    const w = photoSetup(true);
    const res = await w.fetch(`/img/${SHA}.webp`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(w.bucket.get).not.toHaveBeenCalled();
  });

  it('while private: 401 before the bucket is touched, then served for the browser only', async () => {
    const w = photoSetup(false);
    const denied = await settle(w.fetch(`/img/${SHA}.webp`));
    expect(denied.status).toBe(401);
    expect((await settle(w.fetch(`/img/${SHA}.webp`, { password: 'wrong' }))).status).toBe(401);
    expect(w.bucket.get).not.toHaveBeenCalled();
    expect(w.bucket.head).not.toHaveBeenCalled();
    const ok = await w.fetch(`/img/${SHA}.webp`, { password: 'site-secret' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(ok.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('gives 404 when the bucket is not bound', async () => {
    const handler = createHandler({ loadSettings: async () => ({ public: true }) });
    const env = { ASSETS: { fetch: vi.fn() } } as unknown as Bindings;
    expect((await handler.fetch(get(`/img/${SHA}.webp`), env)).status).toBe(404);
  });
});
