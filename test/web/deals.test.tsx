// @vitest-environment jsdom
// Deals page against a mocked read API (fetch stub).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';
import type { Card } from '@/lib/api';

function setViewport(width: number): void {
  window.matchMedia = ((query: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    return {
      matches: min ? width >= Number(min[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  }) as typeof window.matchMedia;
}

function card(id: number, extra: Partial<Card> = {}): Card {
  return {
    id,
    title: `Product ${id}`,
    shop: 'Alpha Shop',
    shopSlug: 'alpha',
    priceCents: 10000 + id,
    wasCents: null,
    verdict: 'good',
    reason: `Reason for ${id}.`,
    bf: false,
    category: null,
    raisedFrom: null,
    wasRaisedFromCents: null,
    ...extra,
  };
}

const cards = (from: number, n: number, extra: Partial<Card> = {}) => Array.from({ length: n }, (_, i) => card(from + i, extra));

const CATEGORIES = {
  categories: [
    { slug: 'laptops', name: 'Laptops', count: 40, good: 30, avoid: 10 },
    { slug: 'toys', name: 'Toys', count: 20, good: 12, avoid: 8 },
    { slug: 'other', name: 'Other', count: 0, good: 0, avoid: 0 },
  ],
};
const SHOPS = {
  shops: [
    { slug: 'alpha', name: 'Alpha Shop', grade: 'B', products: 10 },
    { slug: 'beta', name: 'Beta Shop', grade: null, products: 5 },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Stubs fetch with one handler per API path; /api/categories and /api/shops answer by default. */
function mockApi(routes: Record<string, Route>) {
  const all: Record<string, Route> = { '/api/categories': () => json(CATEGORIES), '/api/shops': () => json(SHOPS), ...routes };
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const route = all[url.pathname];
    return route ? route(url, init) : json({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** A /api/deals answer: `total` deals, 24 per page, ids from 1 (good) or 101 (avoid). */
const deals =
  (total = 30, minHistoryDays = 14): Route =>
  (url) => {
    const avoid = url.searchParams.get('type') === 'avoid';
    const page = Number(url.searchParams.get('page') ?? '1');
    const n = Math.max(0, Math.min(24, total - (page - 1) * 24));
    const start = (avoid ? 100 : 0) + (page - 1) * 24 + 1;
    return json({ items: cards(start, n, { verdict: avoid ? 'avoid' : 'good' }), total, minHistoryDays });
  };

const dealCalls = (fn: ReturnType<typeof mockApi>) =>
  fn.mock.calls.map(([input]) => new URL(String(input), 'http://localhost')).filter((u) => u.pathname === '/api/deals');
const lastDeal = (fn: ReturnType<typeof mockApi>) => dealCalls(fn).at(-1)!;

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

function renderAt(path: string, mode: 'simple' | 'advanced' = 'simple') {
  localStorage.setItem('mode', mode);
  return render(
    <ModeProvider>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <Where />
      </MemoryRouter>
    </ModeProvider>,
  );
}

const where = () => screen.getByTestId('where').textContent ?? '';
const params = () => new URLSearchParams(where().split('?')[1] ?? '');
const status = () => screen.getByTestId('deals-status');
const articles = () => screen.getAllByRole('article');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  localStorage.clear();
  setViewport(1024);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('deals page: list and switch', () => {
  it('shows one h1, asks for good deals by default and lists the first 24 of the total', async () => {
    const fn = mockApi({ '/api/deals': deals(30) });
    renderAt('/deals');
    await waitFor(() => expect(articles()).toHaveLength(24));
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(lastDeal(fn).search).toBe('?type=good');
    expect(status().textContent).toBe('30 deals, 24 shown');
  });

  it('keeps one persistent role=status element that is there before the deals load', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockApi({ '/api/deals': async (url, init) => (await gate, deals(3)(url, init)) });
    renderAt('/deals');
    const el = status();
    expect(el.getAttribute('role')).toBe('status');
    expect(el.className).toContain('sr-only');
    expect(el.textContent).toBe('Loading deals');
    release();
    await waitFor(() => expect(el.textContent).toBe('3 deals'));
    expect(screen.getByTestId('deals-status')).toBe(el);
  });

  it('switching to Avoid requests type=avoid, writes it to the URL and aborts the request in flight', async () => {
    const signals: AbortSignal[] = [];
    let first = true;
    const fn = mockApi({
      '/api/deals': (url, init) => {
        signals.push(init!.signal!);
        if (first) {
          first = false;
          return new Promise<Response>(() => {}); // the first request never answers
        }
        return deals(30)(url, init);
      },
    });
    renderAt('/deals');
    await waitFor(() => expect(dealCalls(fn)).toHaveLength(1));
    const group = screen.getByRole('radiogroup', { name: 'Deal type' });
    expect(within(group).getByRole('radio', { name: 'Good deals' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(group).getByRole('radio', { name: 'Deals to avoid' }));
    await waitFor(() => expect(lastDeal(fn).searchParams.get('type')).toBe('avoid'));
    expect(signals[0]!.aborted).toBe(true);
    expect(params().get('type')).toBe('avoid');
    await waitFor(() => expect(articles()).toHaveLength(24));
    expect(within(group).getByRole('radio', { name: 'Deals to avoid' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Product 101')).toBeTruthy();
  });

  it('clicking the selected side again keeps it selected', async () => {
    const fn = mockApi({ '/api/deals': deals(3) });
    renderAt('/deals?type=avoid');
    await waitFor(() => expect(articles()).toHaveLength(3));
    fireEvent.click(screen.getByRole('radio', { name: 'Deals to avoid' }));
    expect(screen.getByRole('radio', { name: 'Deals to avoid' }).getAttribute('aria-checked')).toBe('true');
    expect(dealCalls(fn)).toHaveLength(1);
  });
});

describe('deals page: filters in the URL', () => {
  it('choosing Laptops adds category=laptops to the request and to the URL', async () => {
    const fn = mockApi({ '/api/deals': deals(5) });
    renderAt('/deals?type=good');
    await waitFor(() => expect(articles()).toHaveLength(5));
    await waitFor(() => expect(within(screen.getByLabelText('Category')).getByRole('option', { name: 'Laptops' })).toBeTruthy());
    choose('Category', 'laptops');
    await waitFor(() => expect(lastDeal(fn).searchParams.get('category')).toBe('laptops'));
    expect(params().get('category')).toBe('laptops');
    expect(params().get('type')).toBe('good');
    expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe('laptops');
    choose('Category', '');
    await waitFor(() => expect(lastDeal(fn).searchParams.has('category')).toBe(false));
    expect(params().has('category')).toBe(false);
  });

  it('reads type, category, shop and price range from the URL', async () => {
    const fn = mockApi({ '/api/deals': deals(5) });
    renderAt('/deals?type=avoid&category=toys&shop=beta&min=10&max=500', 'advanced');
    await waitFor(() => expect(articles()).toHaveLength(5));
    expect(lastDeal(fn).search).toBe('?type=avoid&category=toys&shop=beta&min=10&max=500');
    expect(screen.getByRole('radio', { name: /Deals to avoid/ }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect((screen.getByLabelText('Shop') as HTMLSelectElement).value).toBe('beta'));
    expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe('toys');
    expect((screen.getByLabelText('Lowest price (EUR)') as HTMLInputElement).value).toBe('10');
    expect((screen.getByLabelText('Highest price (EUR)') as HTMLInputElement).value).toBe('500');
  });

  it('ignores a type, category, price or shop in the URL that the API would reject', async () => {
    const fn = mockApi({ '/api/deals': deals(2) });
    renderAt('/deals?type=bogus&category=cars&shop=Bad%20Shop&min=-4&max=1.5');
    await waitFor(() => expect(articles()).toHaveLength(2));
    expect(dealCalls(fn)).toHaveLength(1);
    expect(lastDeal(fn).search).toBe('?type=good');
  });

  it('ignores a price range whose minimum is above its maximum', async () => {
    const fn = mockApi({ '/api/deals': deals(2) });
    renderAt('/deals?min=500&max=100');
    await waitFor(() => expect(articles()).toHaveLength(2));
    expect(lastDeal(fn).search).toBe('?type=good');
  });

  it('Advanced: choosing a shop adds shop=beta', async () => {
    const fn = mockApi({ '/api/deals': deals(5) });
    renderAt('/deals', 'advanced');
    await waitFor(() => expect(articles()).toHaveLength(5));
    await waitFor(() => expect(within(screen.getByLabelText('Shop')).getByRole('option', { name: 'Beta Shop' })).toBeTruthy());
    choose('Shop', 'beta');
    await waitFor(() => expect(lastDeal(fn).searchParams.get('shop')).toBe('beta'));
    expect(params().get('shop')).toBe('beta');
  });

  it('Advanced: a price range is sent in whole euros once the typing settles, and cleared again', async () => {
    const fn = mockApi({ '/api/deals': deals(5) });
    renderAt('/deals', 'advanced');
    await waitFor(() => expect(articles()).toHaveLength(5));
    const calls = dealCalls(fn).length;
    fireEvent.change(screen.getByLabelText('Lowest price (EUR)'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Lowest price (EUR)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Highest price (EUR)'), { target: { value: '500' } });
    expect(dealCalls(fn)).toHaveLength(calls); // nothing yet: still typing
    await waitFor(() => expect(lastDeal(fn).searchParams.get('max')).toBe('500'), { timeout: 3000 });
    expect(lastDeal(fn).searchParams.get('min')).toBe('10');
    expect(dealCalls(fn)).toHaveLength(calls + 1);
    expect(params().get('min')).toBe('10');
    expect(params().get('max')).toBe('500');
    fireEvent.change(screen.getByLabelText('Lowest price (EUR)'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Highest price (EUR)'), { target: { value: '' } });
    await waitFor(() => expect(lastDeal(fn).searchParams.has('max')).toBe(false), { timeout: 3000 });
    expect(lastDeal(fn).searchParams.has('min')).toBe(false);
  });

  it('Advanced: a price that is not whole euros, or a lowest above the highest, is explained and not sent', async () => {
    const fn = mockApi({ '/api/deals': deals(5) });
    renderAt('/deals', 'advanced');
    await waitFor(() => expect(articles()).toHaveLength(5));
    const calls = dealCalls(fn).length;
    const lo = screen.getByLabelText('Lowest price (EUR)');
    fireEvent.change(lo, { target: { value: '12.5' } });
    expect(lo.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Use whole euros from 0 to 100000.')).toBeTruthy();
    fireEvent.change(lo, { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Highest price (EUR)'), { target: { value: '100' } });
    expect(screen.getByText('The lowest price is above the highest.')).toBeTruthy();
    await sleep(700);
    expect(dealCalls(fn)).toHaveLength(calls);
    fireEvent.change(screen.getByLabelText('Highest price (EUR)'), { target: { value: '900' } });
    expect(screen.queryByText('The lowest price is above the highest.')).toBeNull();
    await waitFor(() => expect(lastDeal(fn).searchParams.get('max')).toBe('900'), { timeout: 3000 });
  });
});

describe('deals page: Simple and Advanced', () => {
  it('Simple shows the category choice only: no counts, shop filter or price range', async () => {
    mockApi({ '/api/deals': deals(5) });
    renderAt('/deals');
    await waitFor(() => expect(articles()).toHaveLength(5));
    await waitFor(() => expect(within(screen.getByLabelText('Category')).getAllByRole('option').length).toBeGreaterThan(1));
    expect(screen.queryByLabelText('Shop')).toBeNull();
    expect(screen.queryByLabelText('Lowest price (EUR)')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Good deals' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Deals to avoid' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Laptops' })).toBeTruthy();
    expect(screen.queryByTestId('deals-count')).toBeNull();
  });

  it('Advanced shows counts from the categories, the shop filter and the price range', async () => {
    mockApi({ '/api/deals': deals(30) });
    renderAt('/deals', 'advanced');
    await waitFor(() => expect(articles()).toHaveLength(24));
    // 30 + 12 + 0 good, 10 + 8 + 0 avoid
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Good deals 42' })).toBeTruthy());
    expect(screen.getByRole('radio', { name: 'Deals to avoid 18' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Laptops (30)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Toys (12)' })).toBeTruthy();
    expect(screen.getByLabelText('Shop')).toBeTruthy();
    expect(screen.getByLabelText('Lowest price (EUR)')).toBeTruthy();
    expect(screen.getByTestId('deals-count').textContent).toBe('30 deals, 24 shown');
    // the category counts follow the side
    fireEvent.click(screen.getByRole('radio', { name: /Deals to avoid/ }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Laptops (10)' })).toBeTruthy());
  });

  it('the list still loads when the categories and shops cannot', async () => {
    mockApi({ '/api/deals': deals(3), '/api/categories': () => json({ error: 'x' }, 500), '/api/shops': () => json({ error: 'x' }, 500) });
    renderAt('/deals', 'advanced');
    await waitFor(() => expect(articles()).toHaveLength(3));
    expect(screen.getByRole('radio', { name: 'Good deals' })).toBeTruthy();
  });

  it('Simple says when a link carries a shop or price filter it has no control for, and clears them', async () => {
    const fn = mockApi({ '/api/deals': deals(3) });
    renderAt('/deals?shop=beta&min=10&category=toys');
    await waitFor(() => expect(articles()).toHaveLength(3));
    expect(lastDeal(fn).search).toBe('?type=good&category=toys&shop=beta&min=10');
    expect(screen.getByText(/Some filters from the link are on: shop, price\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear shop and price' }));
    await waitFor(() => expect(lastDeal(fn).search).toBe('?type=good&category=toys'));
    expect(params().has('shop')).toBe(false);
    expect(params().get('category')).toBe('toys');
    expect(screen.queryByText(/Some filters from the link/)).toBeNull();
  });
});

describe('deals page: Load more', () => {
  it('appends the next page, moves focus to the first new card and hides the button after the last page', async () => {
    const fn = mockApi({ '/api/deals': deals(30) });
    renderAt('/deals');
    await waitFor(() => expect(articles()).toHaveLength(24));
    const more = screen.getByRole('button', { name: 'Load more' });
    fireEvent.click(more);
    await waitFor(() => expect(articles()).toHaveLength(30));
    expect(lastDeal(fn).searchParams.get('page')).toBe('2');
    expect(screen.getByText('Product 1')).toBeTruthy(); // page 1 is still there
    expect(screen.getByText('Product 30')).toBeTruthy();
    const first = screen.getByRole('link', { name: 'Product 25' });
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(status().textContent).toBe('30 deals');
    // the page number is not in the URL
    expect(params().has('page')).toBe(false);
  });

  it('shows that it is loading, ignores a second click and announces the new count', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fn = mockApi({
      '/api/deals': async (url, init) => {
        if (Number(url.searchParams.get('page') ?? '1') > 1) await gate;
        return deals(60)(url, init);
      },
    });
    renderAt('/deals');
    await waitFor(() => expect(articles()).toHaveLength(24));
    expect(status().textContent).toBe('60 deals, 24 shown');
    const more = screen.getByRole('button', { name: 'Load more' });
    fireEvent.click(more);
    await waitFor(() => expect(more.getAttribute('aria-disabled')).toBe('true'));
    expect(status().textContent).toBe('Loading more deals');
    fireEvent.click(more);
    expect(dealCalls(fn).filter((u) => u.searchParams.get('page') === '2')).toHaveLength(1);
    release();
    await waitFor(() => expect(articles()).toHaveLength(48));
    expect(status().textContent).toBe('60 deals, 48 shown');
    expect(screen.getByRole('button', { name: 'Load more' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('does not offer Load more when everything fits on one page', async () => {
    mockApi({ '/api/deals': deals(24) });
    renderAt('/deals');
    await waitFor(() => expect(articles()).toHaveLength(24));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('a failed page keeps the cards, says so, and Try again loads it', async () => {
    let fail = true;
    const fn = mockApi({
      '/api/deals': (url, init) => (Number(url.searchParams.get('page') ?? '1') === 2 && fail ? json({ error: 'x' }, 500) : deals(30)(url, init)),
    });
    renderAt('/deals');
    await waitFor(() => expect(articles()).toHaveLength(24));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('More deals could not be loaded.')).toBeTruthy());
    expect(articles()).toHaveLength(24);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(articles()).toHaveLength(30));
    expect(dealCalls(fn).filter((u) => u.searchParams.get('page') === '2')).toHaveLength(2);
  });

  it('changing a filter after Load more starts again at page 1 and drops the old cards', async () => {
    const fn = mockApi({ '/api/deals': deals(60) });
    renderAt('/deals');
    await waitFor(() => expect(articles()).toHaveLength(24));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(articles()).toHaveLength(48));
    fireEvent.click(screen.getByRole('radio', { name: 'Deals to avoid' }));
    await waitFor(() => expect(lastDeal(fn).searchParams.get('type')).toBe('avoid'));
    expect(lastDeal(fn).searchParams.has('page')).toBe(false);
    await waitFor(() => expect(articles()).toHaveLength(24));
    expect(screen.queryByText('Product 1')).toBeNull();
    expect(screen.getByText('Product 101')).toBeTruthy();
  });

  it('a late answer for an old filter never replaces the current list', async () => {
    const resolvers: Array<() => void> = [];
    mockApi({
      '/api/deals': (url, init) =>
        new Promise<Response>((resolve) => {
          resolvers.push(() => resolve(deals(5)(url, init)));
        }),
    });
    renderAt('/deals?type=good');
    await waitFor(() => expect(resolvers).toHaveLength(1));
    fireEvent.click(screen.getByRole('radio', { name: 'Deals to avoid' }));
    await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]!();
    await waitFor(() => expect(articles()).toHaveLength(5));
    resolvers[0]!(); // the old answer arrives late
    await sleep(50);
    expect(articles()).toHaveLength(5);
    expect(screen.getByText('Product 101')).toBeTruthy();
    expect(screen.queryByText('Product 1')).toBeNull();
  });
});

describe('deals page: empty, error and safety', () => {
  it('with no deals judged yet explains how many days of prices are needed', async () => {
    mockApi({ '/api/deals': () => json({ items: [], total: 0, minHistoryDays: 21 }) });
    renderAt('/deals');
    await waitFor(() => expect(screen.getByText('No good deals judged yet.')).toBeTruthy());
    expect(screen.getByText(/We need 21 days of prices before we judge a deal\./)).toBeTruthy();
    expect(status().textContent).toBe('0 deals');
  });

  it('with filters on says nothing matched and Clear filters removes them', async () => {
    const fn = mockApi({
      '/api/deals': (url, init) => (url.searchParams.has('category') ? json({ items: [], total: 0, minHistoryDays: 14 }) : deals(3)(url, init)),
    });
    renderAt('/deals?type=avoid&category=toys');
    await waitFor(() => expect(screen.getByText('No deals match these filters.')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(articles()).toHaveLength(3));
    expect(lastDeal(fn).search).toBe('?type=avoid');
    expect(where()).toBe('/deals?type=avoid');
  });

  it('shows an error with Try again when the deals cannot be loaded', async () => {
    let fail = true;
    mockApi({ '/api/deals': (url, init) => (fail ? json({ error: 'x' }, 500) : deals(3)(url, init)) });
    renderAt('/deals');
    await waitFor(() => expect(screen.getByText('Deals could not be loaded.')).toBeTruthy());
    expect(status().textContent).toBe('Deals could not be loaded');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(articles()).toHaveLength(3));
  });

  it('treats a 200 answer of the wrong shape as an error', async () => {
    mockApi({ '/api/deals': () => json({}) });
    renderAt('/deals');
    await waitFor(() => expect(screen.getByText('Deals could not be loaded.')).toBeTruthy());
  });

  it('renders shop text as text, never as HTML', async () => {
    mockApi({
      '/api/deals': () => json({ items: [card(1, { title: '<img src=x onerror=alert(1)> Laptop', shop: '<b>Evil</b>' })], total: 1, minHistoryDays: 14 }),
    });
    const { container } = renderAt('/deals');
    await waitFor(() => expect(articles()).toHaveLength(1));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)> Laptop')).toBeTruthy();
  });

  it('shows the Black Friday avoid alarm and "Price not shown by the shop" on the cards', async () => {
    mockApi({
      '/api/deals': () =>
        json({
          items: [
            card(1, { verdict: 'avoid', bf: true, priceCents: null }),
            card(2, { verdict: 'avoid', bf: true, priceCents: 79900, wasCents: 88900, raisedFrom: { priceCents: 70900, at: '2026-10-20' } }),
          ],
          total: 2,
          minHistoryDays: 14,
        }),
    });
    renderAt('/deals?type=avoid');
    await waitFor(() => expect(articles()).toHaveLength(2));
    expect(articles().every((a) => a.getAttribute('data-alarm') === 'true')).toBe(true);
    expect(screen.getByText('Price not shown by the shop')).toBeTruthy();
    expect(screen.queryByText(/0\.00/)).toBeNull();
  });
});
