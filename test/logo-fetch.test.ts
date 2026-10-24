// The logo job's polite getter (src/pipeline/logos.ts politeLogoGet) over ShopFetcher with a stubbed safeFetch: one
// budget of 4 requests for the shop and its image CDN together, robots.txt per host, at least 2 s between requests
// to a host, and only allowlisted picture hosts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const answers = vi.hoisted(() => ({ route: (_url: string): Response => new Response('', { status: 404 }), log: [] as { url: string; at: number; ua: string }[] }));
vi.mock('../src/http/safeNet.js', () => ({
  safeFetch: vi.fn(async (url: string, init: { headers?: Record<string, string> } = {}) => {
    answers.log.push({ url, at: Date.now(), ua: init.headers?.['user-agent'] ?? '' });
    return answers.route(url);
  }),
}));

const { DisallowedError, ShopAbortError } = await import('../src/http/fetcher.js');
const { LOGO_MAX_REQUESTS, politeLogoGet } = await import('../src/pipeline/logos.js');

const shop = { id: 1, slug: 'gadget', name: 'Gadget', base_url: 'https://gadget.example.mt', config: { min_delay_ms: 0, max_delay_ms: 0 } };

beforeEach(() => {
  answers.log = [];
  process.env.SCRAPER_USER_AGENT = 'MTPIndex/1.0 (test)';
  // the gap is then exactly the 2 s minimum
  vi.spyOn(Math, 'random').mockReturnValue(0);
  answers.route = (url) =>
    url.endsWith('/robots.txt') ? new Response('User-agent: *\nDisallow: /private/\n') : new Response('ok', { headers: { 'content-type': 'text/html' } });
});
afterEach(() => vi.restoreAllMocks());

describe('politeLogoGet', () => {
  it('shares 4 requests between the shop and its CDN, keeps 2 s per host and sends our user agent', async () => {
    const get = politeLogoGet(shop);
    await get('https://gadget.example.mt/', 'page');
    await get('https://cdn.shopify.com/s/files/logo.png', 'image');
    await expect(get('https://gadget.example.mt/logo2.png', 'image')).rejects.toThrow(ShopAbortError);
    expect(answers.log.map((l) => l.url)).toEqual([
      'https://gadget.example.mt/robots.txt',
      'https://gadget.example.mt/',
      'https://cdn.shopify.com/robots.txt',
      'https://cdn.shopify.com/s/files/logo.png',
    ]);
    expect(answers.log).toHaveLength(LOGO_MAX_REQUESTS);
    // the shop's own config asks for no gap; the logo job keeps the 2 s default anyway
    expect(answers.log[1]!.at - answers.log[0]!.at).toBeGreaterThanOrEqual(1990);
    expect(answers.log[3]!.at - answers.log[2]!.at).toBeGreaterThanOrEqual(1990);
    expect(new Set(answers.log.map((l) => l.ua))).toEqual(new Set(['MTPIndex/1.0 (test)']));
  }, 30_000);

  it('obeys robots.txt and refuses picture hosts outside the allowlist without a request', async () => {
    const get = politeLogoGet(shop);
    await expect(get('https://gadget.example.mt/private/logo.png', 'image')).rejects.toThrow(DisallowedError);
    await expect(get('https://tracker.example.com/logo.png', 'image')).rejects.toThrow(/not in the allowlist/);
    expect(answers.log.map((l) => l.url)).toEqual(['https://gadget.example.mt/robots.txt']);
  });
});
