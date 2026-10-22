import { describe, expect, it } from 'vitest';
import { injectNonce, newNonce, withSecurityHeaders } from '../../web/worker/security.js';

describe('withSecurityHeaders', () => {
  it('adds a CSP containing the nonce and the standard headers', () => {
    const res = withSecurityHeaders(new Response('<html></html>', { headers: { 'content-type': 'text/html' } }), 'abc123');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("'nonce-abc123'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-type')).toBe('text/html');
  });

  it('works on responses with immutable headers and keeps status and body', async () => {
    const original = Response.redirect('https://guide.example/x', 302); // immutable headers
    const res = withSecurityHeaders(original);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://guide.example/x');
    expect(res.headers.get('content-security-policy')).not.toContain('nonce-');
    const body = withSecurityHeaders(new Response('hello', { status: 404 }));
    expect(body.status).toBe(404);
    expect(await body.text()).toBe('hello');
  });
});

describe('newNonce', () => {
  it('returns a fresh base64 value each call', () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(a.length).toBeGreaterThanOrEqual(22);
    expect(a).not.toBe(b);
  });
});

describe('injectNonce', () => {
  it('adds the nonce to every script tag', () => {
    const html = '<head><script>1</script><script type="module" src="/a.js"></script></head>';
    expect(injectNonce(html, 'n1')).toBe(
      '<head><script nonce="n1">1</script><script nonce="n1" type="module" src="/a.js"></script></head>',
    );
  });
});
