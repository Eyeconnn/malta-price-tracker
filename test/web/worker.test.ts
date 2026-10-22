import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
