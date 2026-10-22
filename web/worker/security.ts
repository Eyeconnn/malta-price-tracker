// Security headers carried over from dashboard/src/worker.ts, plus a per-request CSP nonce.

const STATIC_HEADERS: Record<string, string> = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function csp(nonce?: string): string {
  const scripts = nonce ? `'self' 'nonce-${nonce}'` : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scripts}`,
    // Radix (dialog, sheet) injects small <style> elements at runtime
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** 16 random bytes, base64. */
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/** Adds the nonce attribute to every <script> tag of a page. */
export function injectNonce(html: string, nonce: string): string {
  return html.replace(/<script\b/g, `<script nonce="${nonce}"`);
}

/** A copy of the response with the security headers set (works on immutable-header responses too). */
export function withSecurityHeaders(res: Response, nonce?: string): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(STATIC_HEADERS)) out.headers.set(k, v);
  out.headers.set('content-security-policy', csp(nonce));
  return out;
}
