// Black Friday Guide: one Worker serves the built web app (static assets) and the JSON API.
// run_worker_first is on, so access control runs before any asset (private mode protects the HTML too).
import { checkAccess } from './auth.js';
import type { Env } from './env.js';
import { injectNonce, newNonce, withSecurityHeaders } from './security.js';
import { loadSiteSettings } from './settings.js';

/** Env plus the static assets binding declared in wrangler.toml. */
export interface Bindings extends Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

async function routeApi(_req: Request, _env: Bindings, _url: URL): Promise<Response> {
  // API routes arrive in later tasks.
  return json({ error: 'not found' }, 404);
}

/** Static asset (SPA fallback to index.html). HTML gets a fresh nonce on its script tags. */
async function serveAsset(req: Request, env: Bindings): Promise<{ res: Response; nonce?: string }> {
  const res = await env.ASSETS.fetch(req);
  if (!(res.headers.get('content-type') ?? '').startsWith('text/html')) return { res };
  const nonce = newNonce();
  const html = injectNonce(await res.text(), nonce);
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-store'); // the nonce changes per request
  headers.delete('content-length');
  headers.delete('etag');
  return { res: new Response(html, { status: res.status, headers }), nonce };
}

export default {
  async fetch(req: Request, env: Bindings): Promise<Response> {
    const url = new URL(req.url);
    const settings = await loadSiteSettings(env.DATABASE_URL);
    const finish = (res: Response, nonce?: string): Response => {
      const out = withSecurityHeaders(res, nonce);
      if (!settings.public) out.headers.set('x-robots-tag', 'noindex, nofollow');
      return out;
    };

    const denied = await checkAccess(req, env, settings);
    if (denied) return finish(denied);

    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return finish(await routeApi(req, env, url));
      const { res, nonce } = await serveAsset(req, env);
      return finish(res, nonce);
    } catch (e) {
      console.error('site error', url.pathname, (e as Error).message);
      return finish(json({ error: 'internal error' }, 500));
    }
  },
};
