// Response cache for the public read API (Neon Build plan: keep compute low). Every read except search is
// cached for 10 minutes in the Workers Cache API. The cache is injected so tests run without the runtime.

/** The subset of the Workers Cache API (caches.default) the API uses. */
export interface ResponseCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
}

export const PUBLIC_CACHE_CONTROL = 'public, max-age=600';

/** caches.default in the Workers runtime, null elsewhere (Node tests, scripts). */
export function defaultCache(): ResponseCache | null {
  const c = (globalThis as { caches?: { default?: ResponseCache } }).caches;
  return c?.default ?? null;
}

/**
 * Serves `key` (an absolute URL built from validated parameters only, so junk query strings cannot bust the
 * cache) from the cache, else builds it. A 200 is stored and returned with PUBLIC_CACHE_CONTROL; anything
 * else is returned as built and not stored. A failing cache never fails the request.
 */
export async function cached(cache: ResponseCache | null, key: string, build: () => Promise<Response>): Promise<Response> {
  const req = new Request(key, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(req);
      if (hit) return hit;
    } catch (e) {
      console.error('api cache read failed', (e as Error).message);
    }
  }
  const res = await build();
  if (res.status !== 200) return res;
  const out = new Response(res.body, res);
  out.headers.set('cache-control', PUBLIC_CACHE_CONTROL);
  if (cache) {
    try {
      await cache.put(req, out.clone());
    } catch (e) {
      console.error('api cache write failed', (e as Error).message);
    }
  }
  return out;
}
