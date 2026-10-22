import { describe, expect, it } from 'vitest';
import { checkAccess } from '../../web/worker/auth.js';
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

describe('checkAccess', () => {
  it('private mode without credentials returns 401 with www-authenticate', async () => {
    const res = await checkAccess(req('/'), env, { public: false });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(res!.headers.get('www-authenticate')).toMatch(/^Basic realm="/);
  });

  it('private mode with the site password is allowed', async () => {
    expect(await checkAccess(req('/', 'site-secret'), env, { public: false })).toBeNull();
    expect(await checkAccess(req('/api/deals', 'site-secret'), env, { public: false })).toBeNull();
  });

  it('private mode with a wrong password returns 401 after a delay', async () => {
    const started = Date.now();
    const res = await checkAccess(req('/', 'nope'), env, { public: false });
    expect(res!.status).toBe(401);
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
  });

  it('private mode rejects malformed authorization headers', async () => {
    const bad = new Request('https://guide.example/', { headers: { authorization: 'Basic !!!not-base64' } });
    expect((await checkAccess(bad, env, { public: false }))!.status).toBe(401);
    const noColon = new Request('https://guide.example/', { headers: { authorization: 'Basic ' + btoa('site-secret') } });
    expect((await checkAccess(noColon, env, { public: false }))!.status).toBe(401);
  });

  it('private mode denies everyone when SITE_PASSWORD is not configured', async () => {
    const res = await checkAccess(req('/', ''), { ...env, SITE_PASSWORD: '' }, { public: false });
    expect(res!.status).toBe(401);
  });

  it('public mode allows requests without credentials', async () => {
    expect(await checkAccess(req('/'), env, { public: true })).toBeNull();
    expect(await checkAccess(req('/shops/abc'), env, { public: true })).toBeNull();
  });

  it('/api/admin/* with the site password (not admin) returns 401', async () => {
    const res = await checkAccess(req('/api/admin/x', 'site-secret'), env, { public: false });
    expect(res!.status).toBe(401);
    expect(res!.headers.get('www-authenticate')).toMatch(/admin/i);
  });

  it('admin paths always require the admin password, even in public mode', async () => {
    for (const path of ['/admin', '/admin/reports', '/api/admin', '/api/admin/settings']) {
      expect((await checkAccess(req(path), env, { public: true }))!.status).toBe(401);
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
});
