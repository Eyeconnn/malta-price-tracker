// Product photos are our own small copies in R2 (src/pipeline/photo.ts), served at /img/<sha256>.webp, so a visitor's
// browser never contacts a shop. The route sits behind the same access check as every other path (private mode
// asks for the site password first).

/** The one URL form of a photo: /img/ + 64 lowercase hex + .webp, nothing else. */
const PHOTO_PATH = /^\/img\/[0-9a-f]{64}\.webp$/;
/** The R2 key of a photo (site_products.image_key). */
const PHOTO_KEY = /^img\/[0-9a-f]{64}\.webp$/;

/** The site URL of a stored photo key, null for anything that is not one. */
export function photoUrl(key: string | null | undefined): string | null {
  return typeof key === 'string' && PHOTO_KEY.test(key) ? `/${key}` : null;
}

/** The URL when it is one of our photo URLs, else null: the API never hands out any other image address. */
export function sitePhoto(url: string | null | undefined): string | null {
  return typeof url === 'string' && PHOTO_PATH.test(url) ? url : null;
}

/** The part of an R2 object the route uses. */
export interface PhotoObject {
  size: number;
  httpEtag: string;
  body?: ReadableStream | null;
}
/** The part of the R2 bucket binding the route uses (wrangler.toml r2_buckets BUCKET). */
export interface PhotoBucket {
  get(key: string): Promise<PhotoObject | null>;
  head(key: string): Promise<PhotoObject | null>;
}

const YEAR = 31_536_000;

function notFound(): Response {
  return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/**
 * GET or HEAD /img/<sha256>.webp: the stored copy as image/webp, cached for a year (the name is the content's hash, so
 * it never changes). While the site is private the copy is only cached by the browser (private). Anything else under
 * /img gets 404 without touching the bucket.
 */
export async function servePhoto(req: Request, pathname: string, bucket: PhotoBucket | undefined, access: { public: boolean }): Promise<Response> {
  if (!PHOTO_PATH.test(pathname) || !bucket) return notFound();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } });
  }
  const key = pathname.slice(1);
  const obj = req.method === 'HEAD' ? await bucket.head(key) : await bucket.get(key);
  if (!obj) return notFound();
  const headers = new Headers({
    'content-type': 'image/webp',
    'cache-control': `${access.public ? 'public' : 'private'}, max-age=${YEAR}, immutable`,
    'x-content-type-options': 'nosniff',
    'content-length': String(obj.size),
    etag: obj.httpEtag,
  });
  return new Response(req.method === 'HEAD' ? null : (obj.body ?? null), { status: 200, headers });
}
