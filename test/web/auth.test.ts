import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalPath, checkAccess, isAdminPath } from '../../web/worker/auth.js';
import type { Env } from '../../web/worker/env.js';

const env: Env = {
  DATABASE_URL: 'postgres://ro@example/db',
  REPORTER_DATABASE_URL: 'postgres://reporter@example/db',
  ADMIN_DATABASE_URL: 'postgres://admin@example/db',
  SITE_PASSWORD: 'site-secret',
  ADMIN_PASSWORD: 'admin-secret',
  SITE_ORIGIN: 'https://guide.example',
  IP_SALT: 'salt',
};

function req(path: string, password?: string, user = 'anyone'): Request {
  const headers: Record<string, string> = {};
  if (password !== undefined) headers.authorization = 'Basic ' + btoa(`${user}:${password}`);
  return new Request('https://guide.example' + path, { headers });
}

/** Waits until the deny delay timer is set, checks it holds the response for exactly 750 ms. */
async function denied(pending: Promise<Response | null>): Promise<Response> {
  let settled = false;
  void pending.then(() => (settled = true));
  for (let i = 0; i < 1000 && vi.getTimerCount() === 0 && !settled; i++) await new Promise((r) => setImmediate(r));
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(749);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const res = await pending;
  expect(res).not.toBeNull();
  return res!;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('checkAccess', () => {
  it('private mode without credentials returns 401 with www-authenticate after 750 ms', async () => {
    const res = await denied(checkAccess(req('/'), env, { public: false }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic realm="/);
  });

  it('private mode with the site password is allowed', async () => {
    expect(await checkAccess(req('/', 'site-secret'), env, { public: false })).toBeNull();
    expect(await checkAccess(req('/api/deals', 'site-secret'), env, { public: false })).toBeNull();
  });

  it('private mode with a wrong password returns 401 after the delay', async () => {
    expect((await denied(checkAccess(req('/', 'nope'), env, { public: false }))).status).toBe(401);
  });

  it('private mode rejects malformed authorization headers', async () => {
    const bad = new Request('https://guide.example/', { headers: { authorization: 'Basic !!!not-base64' } });
    expect((await denied(checkAccess(bad, env, { public: false }))).status).toBe(401);
    const noColon = new Request('https://guide.example/', { headers: { authorization: 'Basic ' + btoa('site-secret') } });
    expect((await denied(checkAccess(noColon, env, { public: false }))).status).toBe(401);
  });

  it('private mode denies everyone when SITE_PASSWORD is not configured', async () => {
    const res = await denied(checkAccess(req('/', ''), { ...env, SITE_PASSWORD: '' }, { public: false }));
    expect(res.status).toBe(401);
  });

  it('public mode allows requests without credentials', async () => {
    expect(await checkAccess(req('/'), env, { public: true })).toBeNull();
    expect(await checkAccess(req('/shops/abc'), env, { public: true })).toBeNull();
  });

  it('/api/admin/* with the site password (not admin) returns 401', async () => {
    const res = await denied(checkAccess(req('/api/admin/x', 'site-secret'), env, { public: false }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/admin/i);
  });

  it('admin paths always require the admin password, even in public mode', async () => {
    for (const path of ['/admin', '/admin/reports', '/api/admin', '/api/admin/settings']) {
      expect((await denied(checkAccess(req(path), env, { public: true }))).status).toBe(401);
      expect(await checkAccess(req(path, 'admin-secret'), env, { public: true })).toBeNull();
    }
  });

  it('paths that only start with "admin" are not admin paths', async () => {
    expect(await checkAccess(req('/administrator'), env, { public: true })).toBeNull();
    expect(await checkAccess(req('/api/adminx'), env, { public: true })).toBeNull();
  });

  it('the admin password also opens the private site', async () => {
    expect(await checkAccess(req('/', 'admin-secret'), env, { public: false })).toBeNull();
  });

  it('a case variant of /admin is still the admin area', async () => {
    expect((await denied(checkAccess(req('/Admin'), env, { public: true }))).status).toBe(401);
    expect((await denied(checkAccess(req('/ADMIN/reports', 'site-secret'), env, { public: true }))).status).toBe(401);
  });

  it('non-canonical /api paths are rejected with 404, even with the admin password', async () => {
    for (const path of ['/api/Admin/settings', '/api//admin/x', '/api/%61dmin/x', '/API/admin/x', '/api/Deals']) {
      for (const password of [undefined, 'site-secret', 'admin-secret']) {
        const res = await checkAccess(req(path, password), env, { public: true });
        expect(res, `${path} ${password}`).not.toBeNull();
        expect(res!.status).toBe(404);
        expect(await res!.json()).toEqual({ error: 'not found' });
      }
    }
  });
});

describe('canonicalPath and isAdminPath', () => {
  it('decodes unreserved characters, collapses slashes and lowercases', () => {
    expect(canonicalPath('/api/%61dmin/x')).toBe('/api/admin/x');
    expect(canonicalPath('/api//admin///x')).toBe('/api/admin/x');
    expect(canonicalPath('/Api/Admin')).toBe('/api/admin');
    expect(canonicalPath('/a%7Eb%2Dc%5Fd%2Ee')).toBe('/a~b-c_d.e');
    // reserved characters stay encoded (only the hex case changes)
    expect(canonicalPath('/api/admin%2Fx')).toBe('/api/admin%2fx');
  });

  it('classes the tricky spellings as admin and the near misses as not', () => {
    for (const p of ['/Admin', '/api/Admin/settings', '/api//admin/x', '/api/%61dmin/x', '//admin']) expect(isAdminPath(p), p).toBe(true);
    for (const p of ['/administrator', '/api/adminx', '/shops/admin-tools', '/']) expect(isAdminPath(p), p).toBe(false);
  });
});
