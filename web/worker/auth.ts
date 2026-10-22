// Access control: private-mode Basic auth for the whole site, admin password for the admin area.
// Logic carried over from dashboard/src/worker.ts (SHA-256 digest compare, 750 ms delay on failure).
import type { Env } from './env.js';
import type { AccessSettings } from './settings.js';

const FAILURE_DELAY_MS = 750;

/**
 * The form used for access decisions: percent-encoded unreserved characters (A-Z a-z 0-9 - . _ ~)
 * decoded, runs of '/' collapsed, lowercased. So /Admin, /api//admin and /api/%61dmin all match.
 */
export function canonicalPath(pathname: string): string {
  return pathname
    .replace(/%([0-9a-f]{2})/gi, (m, hex: string) => {
      const ch = String.fromCharCode(parseInt(hex, 16));
      return /[A-Za-z0-9\-._~]/.test(ch) ? ch : m;
    })
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

/** True for /admin, /admin/..., /api/admin and /api/admin/... in any spelling (not /administrator). */
export function isAdminPath(pathname: string): boolean {
  return /^\/(api\/)?admin(\/|$)/.test(canonicalPath(pathname));
}

function isApiPath(canonical: string): boolean {
  return canonical === '/api' || canonical.startsWith('/api/');
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** The password from an HTTP Basic authorization header (any user name), or null. */
function basicPassword(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  if (!h.startsWith('Basic ')) return null;
  let decoded = '';
  try {
    decoded = atob(h.slice(6));
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  return sep < 0 ? null : decoded.slice(sep + 1);
}

/** Compares SHA-256 digests so the comparison time does not depend on the password. */
async function matches(given: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

async function denied(realm: string): Promise<Response> {
  // slow down password guessing
  await new Promise((r) => setTimeout(r, FAILURE_DELAY_MS));
  return new Response('Login required', {
    status: 401,
    headers: {
      'www-authenticate': `Basic realm="${realm}", charset="UTF-8"`,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Null when the request may proceed, otherwise the response to send.
 * An /api path not already in canonical form gets 404, so API routing never sees a spelling the
 * admin gate did not. Admin paths (any spelling) always need ADMIN_PASSWORD. While the site is private every other path needs
 * SITE_PASSWORD (the admin password works too, so the owner is not asked twice).
 */
export async function checkAccess(req: Request, env: Env, settings: AccessSettings): Promise<Response | null> {
  const pathname = new URL(req.url).pathname;
  const canonical = canonicalPath(pathname);
  if (isApiPath(canonical) && canonical !== pathname) return notFound();
  const password = basicPassword(req);

  if (isAdminPath(canonical)) {
    if (password !== null && (await matches(password, env.ADMIN_PASSWORD))) return null;
    return denied('Black Friday Guide admin');
  }
  if (settings.public) return null;
  if (password !== null) {
    const [site, admin] = await Promise.all([matches(password, env.SITE_PASSWORD), matches(password, env.ADMIN_PASSWORD)]);
    if (site || admin) return null;
  }
  return denied('Black Friday Guide');
}
