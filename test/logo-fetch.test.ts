// The logo job's polite getter (src/pipeline/logos.ts politeLogoGet) over ShopFetcher with a stubbed safeFetch: at
// most 4 requests to the shop (robots.txt, retries and redirect hops included), 2 to an image CDN host, robots.txt
// per host, at least 2 s between requests to a host, one redirect hop, and only allowlisted picture hosts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const answers = vi.hoisted(() => ({ route: (_url: string): Response => new Response('', { status: 404 }), log: [] as { url: string; at: number; ua: string }[] }));
vi.mock('../src/http/safeNet.js', () => ({
  safeFetch: vi.fn(async (url: string, init: { headers?: Record<string, string> } = {}) => {
    answers.log.push({ url, at: Date.now(), ua: init.headers?.['user-agent'] ?? '' });
    return answers.route(url);
  }),
}));

const { DisallowedError, ShopAbortError, TooManyRedirectsError } = await import('../src/http/fetcher.js');
const { LOGO_MAX_REQUESTS, LogoRetryLaterError, isTransient, politeLogoGet } = await import('../src/pipeline/logos.js');

const shop = { id: 1, slug: 'gadget', name: 'Gadget', base_url: 'https://gadget.example.mt', config: { min_delay_ms: 0, max_delay_ms: 0 } };
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
const robotsOk = () => new Response('User-agent: *\nDisallow: /private/\n');
const paths = () => answers.log.map((l) => l.url);

beforeEach(() => {
  answers.log = [];
  process.env.SCRAPER_USER_AGENT = 'MTPIndex/1.0 (test)';
  // the gap is then exactly the 2 s minimum
  vi.spyOn(Math, 'random').mockReturnValue(0);
  answers.route = (url) => (url.endsWith('/robots.txt') ? robotsOk() : new Response('ok', { headers: { 'content-type': 'text/html' } }));
});
afterEach(() => vi.restoreAllMocks());

describe('politeLogoGet', () => {
  it('makes at most 4 requests to the shop, keeps 2 s between them and sends our user agent', async () => {
    const get = politeLogoGet(shop);
    await get('https://gadget.example.mt/', 'page');
    await get('https://gadget.example.mt/logo1.png', 'image');
    await get('https://gadget.example.mt/logo2.png', 'image');
    await expect(get('https://gadget.example.mt/logo3.png', 'image')).rejects.toThrow(ShopAbortError);
    expect(answers.log).toHaveLength(LOGO_MAX_REQUESTS);
    // the shop's own config asks for no gap; the logo job keeps the 2 s default anyway
    for (let i = 1; i < answers.log.length; i++) expect(answers.log[i]!.at - answers.log[i - 1]!.at, `gap ${i}`).toBeGreaterThanOrEqual(1990);
    expect(new Set(answers.log.map((l) => l.ua))).toEqual(new Set(['MTPIndex/1.0 (test)']));
  }, 30_000);

  it('a logo on an image CDN costs that host its robots.txt and the picture, 2 s apart', async () => {
    const get = politeLogoGet(shop);
    await get('https://cdn.shopify.com/s/files/logo.png', 'image');
    expect(paths()).toEqual(['https://cdn.shopify.com/robots.txt', 'https://cdn.shopify.com/s/files/logo.png']);
    expect(answers.log[1]!.at - answers.log[0]!.at).toBeGreaterThanOrEqual(1990);
    await expect(get('https://cdn.shopify.com/s/files/other.png', 'image')).rejects.toThrow(ShopAbortError);
  }, 30_000);

  it('follows one redirect hop as a counted request after the gap, never a second', async () => {
    answers.route = (url) =>
      url.endsWith('/robots.txt') ? robotsOk() : url.endsWith('/') ? redirect('/en/') : url.endsWith('/en/') ? redirect('/en/home') : new Response('ok');
    const get = politeLogoGet(shop);
    await expect(get('https://gadget.example.mt/', 'page')).rejects.toThrow(TooManyRedirectsError);
    expect(paths()).toEqual(['https://gadget.example.mt/robots.txt', 'https://gadget.example.mt/', 'https://gadget.example.mt/en/']);
    expect(answers.log[2]!.at - answers.log[1]!.at).toBeGreaterThanOrEqual(1990);
  }, 30_000);

  it('follows a shop picture that redirects to an allowlisted CDN, with no further hop there', async () => {
    answers.route = (url) =>
      url.endsWith('/robots.txt') ? robotsOk() : url === 'https://gadget.example.mt/logo.png' ? redirect('https://cdn.shopify.com/s/logo.png') : new Response('png');
    const get = politeLogoGet(shop);
    const res = await get('https://gadget.example.mt/logo.png', 'image');
    expect(res.url).toBe('https://cdn.shopify.com/s/logo.png');
    expect(paths()).toEqual([
      'https://gadget.example.mt/robots.txt',
      'https://gadget.example.mt/logo.png',
      'https://cdn.shopify.com/robots.txt',
      'https://cdn.shopify.com/s/logo.png',
    ]);
  }, 30_000);

  it('obeys robots.txt and refuses picture hosts outside the allowlist without a request', async () => {
    const get = politeLogoGet(shop);
    await expect(get('https://gadget.example.mt/private/logo.png', 'image')).rejects.toThrow(DisallowedError);
    await expect(get('https://tracker.example.com/logo.png', 'image')).rejects.toThrow(/not in the allowlist/);
    expect(paths()).toEqual(['https://gadget.example.mt/robots.txt']);
  });

  it('robots.txt answering server errors means try again on a later run, not "no logo"', async () => {
    answers.route = (url) => (url.endsWith('/robots.txt') ? new Response('busy', { status: 503, headers: { 'retry-after': '0' } }) : new Response('ok'));
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const pending = politeLogoGet(shop)('https://gadget.example.mt/', 'page').catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const err = await pending;
      expect(err).toBeInstanceOf(LogoRetryLaterError);
      expect(isTransient(err)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
