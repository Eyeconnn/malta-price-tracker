// Black Friday Guide: one Worker serves the built web app (static assets) and the JSON API.
// run_worker_first is on, so access control runs before any asset (private mode protects the HTML too).
import { type ApiDeps, handleApi } from './api.js';
import { canonicalPath, checkAccess, isAdminPath } from './auth.js';
import { defaultCache } from './cache.js';
import { neonData } from './data.js';
import type { Env } from './env.js';
import { json } from './http.js';
import { type PhotoBucket, servePhoto } from './photo.js';
import { injectNonce, newNonce, withSecurityHeaders } from './security.js';
import { type AccessSettings, loadSiteSettings } from './settings.js';

/** Env plus the static assets and R2 photo bindings declared in wrangler.toml. */
export interface Bindings extends Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  /** our small product photo copies (img/<sha256>.webp) */
  BUCKET?: PhotoBucket;
}

export { json };

/** Production API dependencies: Neon with the read-only role and the Workers cache. */
const DEFAULT_API: ApiDeps = { data: (env) => neonData(env.DATABASE_URL), cache: defaultCache };

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

export interface HandlerDeps {
  loadSettings: (env: Bindings) => Promise<AccessSettings>;
  /** read API data and cache; defaults to DEFAULT_API */
  api?: ApiDeps;
}

/** The fetch handler; settings loading is injected so tests run without a database. */
export function createHandler(deps: HandlerDeps) {
  return {
    async fetch(req: Request, env: Bindings): Promise<Response> {
      const url = new URL(req.url);
      const settings = await deps.loadSettings(env);
      const finish = (res: Response, nonce?: string): Response => {
        const out = withSecurityHeaders(res, nonce);
        // the admin area is never indexed, also while the site is public
        if (!settings.public || isAdminPath(url.pathname)) out.headers.set('x-robots-tag', 'noindex, nofollow');
        return out;
      };

      // access control first: also rejects non-canonical /api spellings
      const denied = await checkAccess(req, env, settings);
      if (denied) return finish(denied);

      try {
        // photos: /img/<sha256>.webp from R2; any other /img path (any spelling) is 404, never the app
        const canonical = canonicalPath(url.pathname);
        if (canonical === '/img' || canonical.startsWith('/img/')) return finish(await servePhoto(req, url.pathname, env.BUCKET, settings));
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return finish(await handleApi(req, env, url, deps.api ?? DEFAULT_API, settings));
        const { res, nonce } = await serveAsset(req, env);
        return finish(res, nonce);
      } catch (e) {
        console.error('site error', url.pathname, (e as Error).message);
        return finish(json({ error: 'internal error' }, 500));
      }
    },
  };
}

export default createHandler({ loadSettings: (env) => loadSiteSettings(env.DATABASE_URL) });
