// Browser shops (config.render = "browser"): ShopFetcher hands HTML page requests to the page renderer, and every
// project rule still applies around it: robots.txt before the page and on the page it ends on, shop hosts only,
// the gap between requests, the request count, and backoff on 429. A fake renderer stands in for Crawl4AI.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRenderer, RenderedPage } from '../src/http/renderer.js';

const answers = vi.hoisted(() => ({ robots: 'User-agent: *\nAllow: /\n', plain: [] as string[] }));
vi.mock('../src/http/safeNet.js', () => ({
  safeFetch: vi.fn(async (url: string) => {
    if (url.endsWith('/robots.txt')) return new Response(answers.robots);
    answers.plain.push(url);
    return new Response('{"plain":true}', { headers: { 'content-type': 'application/json' } });
  }),
}));

const { DisallowedError, HttpError, RedirectOutOfScopeError, ShopFetcher } = await import('../src/http/fetcher.js');

const UA = 'MTPIndex/1.0 (price index crawler)';

function fakeRenderer(answer: (url: string) => Partial<RenderedPage> = () => ({})) {
  const calls: { url: string; allowedHosts: string[]; waitFor?: string; at: number }[] = [];
  const renderer: PageRenderer = {
    render: vi.fn(async (url: string, opts: { allowedHosts: string[]; waitFor?: string; timeoutMs: number }) => {
      calls.push({ url, allowedHosts: opts.allowedHosts, waitFor: opts.waitFor, at: Date.now() });
      return { status: 200, url, html: `<html><body>rendered ${url}</body></html>`, ...answer(url) };
    }),
    close: async () => {},
  };
  return { renderer, calls };
}

const fetcher = (renderer: PageRenderer, over: Record<string, unknown> = {}) =>
  new ShopFetcher({ userAgent: UA, minDelayMs: 0, maxDelayMs: 0, allowedHosts: ['shop.example.mt'], renderer, renderWaitFor: '.product-grid', ...over });

beforeEach(() => {
  answers.robots = 'User-agent: *\nAllow: /\n';
  answers.plain = [];
});

describe('a browser shop', () => {
  it('renders HTML pages, with the shop hosts and the selector to wait for, and counts each as a request', async () => {
    const { renderer, calls } = fakeRenderer();
    const f = fetcher(renderer);
    const res = await f.get('https://shop.example.mt/c/toys', { accept: 'text/html' });
    expect(res.text()).toBe('<html><body>rendered https://shop.example.mt/c/toys</body></html>');
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: 'https://shop.example.mt/c/toys', allowedHosts: ['shop.example.mt'], waitFor: '.product-grid', at: expect.any(Number) }]);
    // robots.txt by plain HTTP with our user agent, then the page
    expect(f.stats.requests).toBe(2);
  });

  it('with render_urls, only matching pages are rendered', async () => {
    const { renderer, calls } = fakeRenderer();
    const f = fetcher(renderer, { renderUrls: /^https:\/\/shop\.example\.mt\/[a-z-]+\/[a-z-]+$/ });
    await f.get('https://shop.example.mt/small-appliances/kettles', { accept: 'text/html' });
    await f.get('https://shop.example.mt/product/small-appliances/kettles/a-kettle', { accept: 'text/html' });
    expect(calls.map((c) => c.url)).toEqual(['https://shop.example.mt/small-appliances/kettles']);
    expect(answers.plain).toEqual(['https://shop.example.mt/product/small-appliances/kettles/a-kettle']);
  });

  it('JSON and other non-page requests stay plain HTTP', async () => {
    const { renderer, calls } = fakeRenderer();
    const f = fetcher(renderer);
    await f.get('https://shop.example.mt/api/products', { accept: 'application/json' });
    await f.get('https://shop.example.mt/img/a.jpg', { accept: 'image/*' });
    expect(calls).toHaveLength(0);
    expect(answers.plain).toEqual(['https://shop.example.mt/api/products', 'https://shop.example.mt/img/a.jpg']);
  });

  it('a page robots.txt disallows never reaches the browser', async () => {
    answers.robots = 'User-agent: *\nDisallow: /checkout\n';
    const { renderer, calls } = fakeRenderer();
    const f = fetcher(renderer);
    await expect(f.get('https://shop.example.mt/checkout', { accept: 'text/html' })).rejects.toThrow(DisallowedError);
    expect(calls).toHaveLength(0);
  });

  it('an address outside the shop never reaches the browser', async () => {
    const { renderer, calls } = fakeRenderer();
    await expect(fetcher(renderer).get('https://other.example.org/', { accept: 'text/html' })).rejects.toThrow(/out-of-scope/);
    expect(calls).toHaveLength(0);
  });

  it('a page that ends outside the shop, or on a disallowed path, is dropped', async () => {
    const away = fakeRenderer(() => ({ url: 'https://other.example.org/landing' }));
    await expect(fetcher(away.renderer).get('https://shop.example.mt/p/1', { accept: 'text/html' })).rejects.toThrow(RedirectOutOfScopeError);
    answers.robots = 'User-agent: *\nDisallow: /private\n';
    const moved = fakeRenderer(() => ({ url: 'https://shop.example.mt/private/x' }));
    await expect(fetcher(moved.renderer).get('https://shop.example.mt/p/1', { accept: 'text/html' })).rejects.toThrow(DisallowedError);
  });

  it('keeps the gap between rendered pages', async () => {
    const { renderer, calls } = fakeRenderer();
    const f = fetcher(renderer, { minDelayMs: 120, maxDelayMs: 120 });
    await f.get('https://shop.example.mt/a', { accept: 'text/html' });
    await f.get('https://shop.example.mt/b', { accept: 'text/html' });
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(115);
  });

  it('a 429 from the page is an HTTP error like any other (rate limiting counted)', async () => {
    const { renderer } = fakeRenderer(() => ({ status: 429, html: '' }));
    const f = fetcher(renderer);
    const err = await f.get('https://shop.example.mt/a', { accept: 'text/html', retries: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as InstanceType<typeof HttpError>).status).toBe(429);
    expect(f.stats.rateLimited).toBe(1);
  });

  it('a bot check (403) is not worked around: it fails as it is', async () => {
    const { renderer, calls } = fakeRenderer(() => ({ status: 403, html: '<html>Just a moment...</html>' }));
    const err = await fetcher(renderer).get('https://shop.example.mt/a', { accept: 'text/html' }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof HttpError>).status).toBe(403);
    expect(calls).toHaveLength(1);
  });
});

describe('Load more', () => {
  const lm = { button: '#LoadMoreItems', items: '.product-card', max_clicks: 10 };

  it('clicks at the fetcher pace, or a longer Crawl-delay, and counts every answer as a request', async () => {
    answers.robots = 'User-agent: *\nCrawl-delay: 1\n';
    const opts: unknown[] = [];
    const renderer: PageRenderer = {
      render: vi.fn(async (url: string, o: unknown) => {
        opts.push(o);
        return { status: 200, url, html: '<html></html>', requests: 5, clicks: 4 };
      }),
      close: async () => {},
    };
    const f = new ShopFetcher({ userAgent: UA, minDelayMs: 100, maxDelayMs: 300, allowedHosts: ['shop.example.mt'], renderer, renderLoadMore: lm });
    await f.get('https://shop.example.mt/c/kettles', { accept: 'text/html' });
    expect(opts[0]).toMatchObject({ loadMore: { button: '#LoadMoreItems', items: '.product-card', maxClicks: 10, gapMs: [1000, 1000] } });
    // robots.txt, the page, then 4 Load more answers
    expect(f.stats.requests).toBe(6);
  });

  it('never clicks past the request cap', async () => {
    const opts: { loadMore?: { maxClicks: number } }[] = [];
    const renderer: PageRenderer = {
      render: vi.fn(async (url: string, o: { loadMore?: { maxClicks: number } }) => {
        opts.push(o);
        return { status: 200, url, html: '' };
      }),
      close: async () => {},
    };
    const f = new ShopFetcher({ userAgent: UA, minDelayMs: 0, maxDelayMs: 0, allowedHosts: ['shop.example.mt'], renderer, renderLoadMore: lm, maxRequests: 5 });
    await f.get('https://shop.example.mt/c/kettles', { accept: 'text/html' });
    // robots.txt and the page are 2 of 5: 3 clicks left
    expect(opts[0]!.loadMore!.maxClicks).toBe(3);
  });
});

describe('ShopFetcher.fromConfig', () => {
  it('a browser shop on a machine without the renderer stops at once', async () => {
    vi.stubEnv('RENDERER_PYTHON', 'Z:/nowhere/python.exe');
    try {
      expect(() => ShopFetcher.fromConfig({ render: 'browser' }, UA, 'https://shop.example.mt')).toThrow(/needs the page renderer/);
      expect(() => ShopFetcher.fromConfig({}, UA, 'https://shop.example.mt')).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
