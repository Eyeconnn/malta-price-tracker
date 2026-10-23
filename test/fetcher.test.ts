// ShopFetcher (src/http/fetcher.ts) against a stubbed safeFetch: request cap, long Retry-After, robots.txt
// Retry-After and size cap, and spacing per shop host (www. and apex share one gap).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const answers = vi.hoisted(() => ({ route: (_url: string): Response => new Response('', { status: 404 }), log: [] as { url: string; at: number }[] }));
vi.mock('../src/http/safeNet.js', () => ({
  safeFetch: vi.fn(async (url: string) => {
    answers.log.push({ url, at: Date.now() });
    return answers.route(url);
  }),
}));

const { HttpError, ShopAbortError, ShopFetcher } = await import('../src/http/fetcher.js');
const { runShop } = await import('../src/pipeline/runShop.js');

const UA = 'MTPIndex/1.0 (price index crawler)';
const fast = (over: Record<string, unknown> = {}) => new ShopFetcher({ userAgent: UA, minDelayMs: 0, maxDelayMs: 0, ...over });

beforeEach(() => {
  answers.log = [];
  answers.route = (url) => (url.endsWith('/robots.txt') ? new Response('User-agent: *\nAllow: /\n') : new Response('{}', { headers: { 'content-type': 'application/json' } }));
});
afterEach(() => vi.useRealTimers());

describe('request cap', () => {
  it('counts robots.txt and every attempt, and throws ShopAbortError past the cap', async () => {
    const f = fast({ maxRequests: 3 });
    await f.get('https://shop.example.mt/a');
    await f.get('https://shop.example.mt/b');
    await expect(f.get('https://shop.example.mt/c')).rejects.toThrow(ShopAbortError);
    await expect(f.get('https://shop.example.mt/d')).rejects.toThrow(/request cap of 3/);
    expect(answers.log).toHaveLength(3);
    expect(f.stats.requests).toBe(3);
  });

  it('no cap by default', async () => {
    const f = fast();
    for (let i = 0; i < 8; i++) await f.get(`https://shop.example.mt/p${i}`);
    expect(f.stats.requests).toBe(9);
  });
});

describe('Retry-After', () => {
  it('longer than the backoff cap: no retry, fails saying how long it was asked to wait', async () => {
    answers.route = (url) => (url.endsWith('/robots.txt') ? new Response('') : new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } }));
    const f = fast();
    const err = await f.get('https://shop.example.mt/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as InstanceType<typeof HttpError>).status).toBe(429);
    expect((err as InstanceType<typeof HttpError>).retryAfterMs).toBe(3_600_000);
    expect((err as Error).message).toMatch(/asked to wait 3600 s/);
    expect(answers.log.filter((l) => l.url.endsWith('/x'))).toHaveLength(1);
    expect(f.stats.rateLimited).toBe(1);
    expect(f.stats.retryAfterMs).toBe(3_600_000);
  });

  it('a final 429 or 5xx is counted as rate limiting, with its Retry-After', async () => {
    answers.route = (url) => (url.endsWith('/robots.txt') ? new Response('') : new Response('busy', { status: 503, headers: { 'retry-after': '5' } }));
    const f = fast();
    const err = (await f.get('https://shop.example.mt/x', { retries: 0 }).catch((e: unknown) => e)) as InstanceType<typeof HttpError>;
    expect(err.status).toBe(503);
    expect(err.retryAfterMs).toBe(5000);
    expect(f.stats.rateLimited).toBe(1);
  });

  it('robots.txt: a long Retry-After is not waited for; robots counts as unreachable with the status kept', async () => {
    answers.route = () => new Response('later', { status: 429, headers: { 'retry-after': '7200' } });
    const f = fast();
    const rules = await f.robotsFor('https://shop.example.mt/');
    expect(rules.status).toBe('unreachable');
    expect(rules.httpStatus).toBe(429);
    expect(rules.retryAfterMs).toBe(7_200_000);
    expect(answers.log).toHaveLength(1);
  });

  it('robots.txt: with retries off, a 503 is not retried', async () => {
    answers.route = () => new Response('down', { status: 503 });
    const f = fast({ maxRetries: 0 });
    const rules = await f.robotsFor('https://shop.example.mt/');
    expect(rules).toMatchObject({ status: 'unreachable', httpStatus: 503 });
    expect(answers.log).toHaveLength(1);
  });
});

describe('robots.txt size', () => {
  it('reads only the first 500 KiB', async () => {
    const filler = `# ${'x'.repeat(98)}\n`.repeat(5300); // about 530 KB of comments
    answers.route = (url) => (url.endsWith('/robots.txt') ? new Response(`User-agent: *\nDisallow: /early\n${filler}Disallow: /late\n`) : new Response('{}'));
    const rules = await fast().robotsFor('https://shop.example.mt/');
    expect(rules.isAllowed('https://shop.example.mt/early')).toBe(false);
    expect(rules.isAllowed('https://shop.example.mt/late')).toBe(true);
  });
});

describe('spacing', () => {
  it('keeps the gap per shop host, so www. and the apex never get two requests at once', async () => {
    const f = new ShopFetcher({ userAgent: UA, minDelayMs: 250, maxDelayMs: 250 });
    await f.get('https://shop.example.mt/a');
    await f.get('https://www.shop.example.mt/b');
    const times = answers.log.map((l) => l.at);
    expect(answers.log.map((l) => l.url)).toEqual([
      'https://shop.example.mt/robots.txt',
      'https://shop.example.mt/a',
      'https://www.shop.example.mt/robots.txt',
      'https://www.shop.example.mt/b',
    ]);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, `gap ${i}`).toBeGreaterThanOrEqual(240);
  });
});

describe('adapters stop at the request cap', () => {
  const shop = (adapter: 'shopify' | 'magento', base: string) => ({
    id: -1,
    slug: 'capped',
    name: 'Capped',
    base_url: base,
    category: null,
    adapter,
    config: { min_delay_ms: 0, max_delay_ms: 0 },
    tier: 'P2' as const,
    active: false,
  });
  const quiet = { log: () => {} };

  it('shopify: endless products.json pages stop at the cap', async () => {
    let n = 0;
    answers.route = (url) => {
      if (url.endsWith('/robots.txt')) return new Response('');
      n++;
      const p = { id: n, title: `P${n}`, handle: `p${n}`, variants: [{ id: 1000 + n, title: 'Default Title', price: '9.99' }] };
      return new Response(JSON.stringify({ products: [p] }), { headers: { 'content-type': 'application/json' } });
    };
    const r = await runShop(shop('shopify', 'https://cap.example.mt'), { dryRun: true, limit: 500, maxRequests: 6, ...quiet });
    expect(r.totals.requests).toBe(6);
    expect(answers.log).toHaveLength(6);
    expect(r.totals.notes).toMatch(/request cap of 6/);
    expect(r.totals.products_seen).toBe(5);
  });

  it('magento pages: endless categories stop at the cap', async () => {
    const cats = Array.from({ length: 40 }, (_, i) => `<a href="https://mage.example.mt/all/cat${i}.html">Cat ${i}</a>`).join('');
    answers.route = (url) => {
      if (url.endsWith('/robots.txt')) return new Response('');
      return new Response(`<html><body><nav class="navigation">${cats}</nav></body></html>`, { headers: { 'content-type': 'text/html' } });
    };
    const r = await runShop(shop('magento', 'https://mage.example.mt'), { dryRun: true, limit: 500, maxRequests: 5, ...quiet });
    expect(r.totals.requests).toBe(5);
    expect(answers.log).toHaveLength(5);
    expect(r.totals.notes).toMatch(/request cap of 5/);
  });
});

describe('per-request body limit (image downloads)', () => {
  it('a larger answer fails at once, without retries', async () => {
    answers.route = (url) => (url.endsWith('/robots.txt') ? new Response('') : new Response(new Uint8Array(2000)));
    const f = fast();
    await expect(f.get('https://shop.example.mt/big.jpg', { maxBodyBytes: 1000 })).rejects.toThrow(/larger than 1000 bytes/);
    expect(answers.log.filter((l) => l.url.endsWith('/big.jpg'))).toHaveLength(1);
    expect(f.stats.retries).toBe(0);
  });

  it('a declared content-length over the limit fails before reading, without retries', async () => {
    answers.route = (url) => (url.endsWith('/robots.txt') ? new Response('') : new Response('x', { headers: { 'content-length': '5000' } }));
    const f = fast();
    await expect(f.get('https://shop.example.mt/big.jpg', { maxBodyBytes: 1000 })).rejects.toThrow(/too large \(5000 bytes\)/);
    expect(answers.log.filter((l) => l.url.endsWith('/big.jpg'))).toHaveLength(1);
  });

  it('never raises the fetcher limit', async () => {
    answers.route = (url) => (url.endsWith('/robots.txt') ? new Response('') : new Response(new Uint8Array(2000)));
    const f = fast({ maxBodyBytes: 1000 });
    await expect(f.get('https://shop.example.mt/big.jpg', { maxBodyBytes: 10_000 })).rejects.toThrow(/larger than 1000 bytes/);
  });
});
