// @vitest-environment jsdom
// Shops list and shop page against a mocked read API (fetch stub).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';
import type { Card, Change, ShopResponse, ShopsResponse } from '@/lib/api';

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

const avoid = (id: number) => card(id, { verdict: 'avoid', priceCents: 79900, raisedFrom: { priceCents: 70900, at: '2026-10-20' } });

const change = (id: number, extra: Partial<Change> = {}): Change => ({
  id,
  title: `Change ${id}`,
  fromCents: 70900,
  toCents: 79900,
  pct: 12.7,
  fromAt: '2026-10-20',
  at: '2026-10-22',
  ...extra,
});

function shopResponse(extra: Partial<ShopResponse> = {}): ShopResponse {
  return {
    shop: { id: 1, slug: 'alpha', name: 'Alpha Shop', url: 'https://alpha.example', category: null },
    rating: { grade: 'D', sentence: '23 of 120 judged products were Deals to Avoid (9 with a raised was price).', judged: 120 },
    avoid: [avoid(11), avoid(12)],
    good: [card(1), card(2)],
    rises: [change(21), change(22, { title: 'Tefal iron', fromCents: 7495, toCents: 8995, pct: 20 })],
    drops: [change(31, { title: 'Finlux fridge', fromCents: 99900, toCents: 93900, pct: -6 })],
    stats: { products: 500, judged: 120, good: 73, avoid: 23, wasRaised: 9, bfMarked: 1287, realDealPct: 61 },
    raiseWindowDays: 14,
    ...extra,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function mockApi(routes: Record<string, Route>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const route = routes[url.pathname];
    return route ? route(url, init) : json({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

function renderAt(path: string) {
  return render(
    <ModeProvider>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <Where />
      </MemoryRouter>
    </ModeProvider>,
  );
}

const searchCalls = (fn: ReturnType<typeof mockApi>) =>
  fn.mock.calls.map(([input]) => new URL(String(input), 'http://localhost')).filter((u) => u.pathname === '/api/search');

beforeEach(() => {
  localStorage.clear();
  setViewport(1024);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('shops list', () => {
  const shops: ShopsResponse = {
    shops: [
      { slug: 'alpha', name: 'Alpha Shop', grade: 'B', products: 1234 },
      { slug: 'beta', name: 'Beta <b>Shop</b>', grade: null, products: 5 },
    ],
  };

  it('lists shops in the API order (by name) with badge, rating and product count, one h1', async () => {
    mockApi({ '/api/shops': () => json(shops) });
    renderAt('/shops');
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const alpha = within(rows[0]!);
    expect(alpha.getByRole('link', { name: /Alpha Shop/ }).getAttribute('href')).toBe('/shops/alpha');
    expect(alpha.getByText('B')).toBeTruthy();
    expect(alpha.getByText(/1,234 products/)).toBeTruthy();
    expect(rows[0]!.textContent).toMatch(/Rating B/);
  });

  it('shows "Not rated yet" instead of a letter for an unrated shop and renders shop text as text', async () => {
    mockApi({ '/api/shops': () => json(shops) });
    const { container } = renderAt('/shops');
    const rows = await screen.findAllByRole('listitem');
    expect(within(rows[1]!).getByText('Not rated yet')).toBeTruthy();
    expect(rows[1]!.textContent).not.toMatch(/\bF\b/);
    expect(within(rows[1]!).getByText(/Beta <b>Shop<\/b>/)).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
  });

  it('says so when there are no shops, and offers a retry on an error', async () => {
    const fn = mockApi({ '/api/shops': () => json({ shops: [] }) });
    renderAt('/shops');
    expect(await screen.findByText(/No shops to show yet/)).toBeTruthy();
    cleanup();
    fn.mockImplementation(async () => json({ error: 'x' }, 500));
    renderAt('/shops');
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('shop page', () => {
  it('shows the badge, name (the only h1), RATING and both lists with up to 5 cards each', async () => {
    const many = shopResponse({ avoid: [11, 12, 13, 14, 15, 16, 17].map(avoid), good: [1, 2, 3, 4, 5, 6, 7].map((i) => card(i)) });
    mockApi({ '/api/shops/alpha': () => json(many) });
    renderAt('/shops/alpha');
    await screen.findByRole('region', { name: 'Deals to avoid here' });
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]!.textContent).toBe('Alpha Shop');
    expect(screen.getByText('RATING')).toBeTruthy();
    expect(screen.getByText(/Rating D/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Deals to avoid here' })).getAllByRole('article')).toHaveLength(5);
    expect(within(screen.getByRole('region', { name: 'Good deals here' })).getAllByRole('article')).toHaveLength(5);
  });

  it('shows "Not rated yet" for a shop with a null grade', async () => {
    mockApi({
      '/api/shops/alpha': () => json(shopResponse({ rating: { grade: null, sentence: 'Only 3 deals judged so far.', judged: 3 } })),
    });
    renderAt('/shops/alpha');
    expect(await screen.findByText('Not rated yet')).toBeTruthy();
    expect(screen.getByText('Only 3 deals judged so far.')).toBeTruthy();
  });

  it('has a "Something wrong?" report button for the shop rating (target: shops.id)', async () => {
    mockApi({ '/api/shops/alpha': () => json(shopResponse()) });
    renderAt('/shops/alpha');
    const button = await screen.findByRole('button', { name: 'Something wrong?' });
    expect(button.getAttribute('data-report-target')).toBe('shop:1');
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Alpha Shop')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Send report' })).toBeTruthy();
  });

  it('uses factual empty states', async () => {
    mockApi({ '/api/shops/alpha': () => json(shopResponse({ avoid: [], good: [] })) });
    renderAt('/shops/alpha');
    expect(await screen.findByText('No deals to avoid at this shop at the moment.')).toBeTruthy();
    expect(screen.getByText('No good deals at this shop at the moment.')).toBeTruthy();
  });

  it('searches inside this shop: the API gets shop=<slug>', async () => {
    const fn = mockApi({
      '/api/shops/alpha': () => json(shopResponse()),
      '/api/search': () => json({ results: [] }),
    });
    renderAt('/shops/alpha');
    const box = await screen.findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'lenovo' } });
    await waitFor(() => expect(searchCalls(fn).length).toBeGreaterThan(0));
    const u = searchCalls(fn)[0]!;
    expect(u.searchParams.get('q')).toBe('lenovo');
    expect(u.searchParams.get('shop')).toBe('alpha');
  });

  it('Enter in the shop search opens the search page limited to the shop', async () => {
    mockApi({ '/api/shops/alpha': () => json(shopResponse()), '/api/search': () => json({ results: [] }) });
    renderAt('/shops/alpha');
    const box = await screen.findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'lenovo' } });
    fireEvent.submit(box.closest('form')!);
    expect(screen.getByTestId('where').textContent).toBe('/search?q=lenovo&shop=alpha');
  });

  it('"See all" links keep the shop and the list type', async () => {
    mockApi({ '/api/shops/alpha': () => json(shopResponse()) });
    renderAt('/shops/alpha');
    const avoidRegion = await screen.findByRole('region', { name: 'Deals to avoid here' });
    expect(within(avoidRegion).getByRole('link', { name: 'See all deals to avoid here' }).getAttribute('href')).toBe('/deals?type=avoid&shop=alpha');
    const goodRegion = screen.getByRole('region', { name: 'Good deals here' });
    expect(within(goodRegion).getByRole('link', { name: 'See all good deals here' }).getAttribute('href')).toBe('/deals?type=good&shop=alpha');
  });

  it('a 200 without the rises list is an error with a retry, not a crash', async () => {
    const { rises: _rises, ...partial } = shopResponse();
    mockApi({ '/api/shops/alpha': () => json(partial) });
    renderAt('/shops/alpha');
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('a 200 without the drops list is an error with a retry', async () => {
    const { drops: _drops, ...partial } = shopResponse();
    mockApi({ '/api/shops/alpha': () => json(partial) });
    renderAt('/shops/alpha');
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('Simple mode hides the stats and tables', async () => {
    mockApi({ '/api/shops/alpha': () => json(shopResponse()) });
    renderAt('/shops/alpha');
    await screen.findByRole('region', { name: 'Good deals here' });
    expect(screen.queryByText('Deals to avoid')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  describe('Advanced', () => {
    beforeEach(() => localStorage.setItem('mode', 'advanced'));

    it('shows the four stats', async () => {
      mockApi({ '/api/shops/alpha': () => json(shopResponse()) });
      renderAt('/shops/alpha');
      const stats = await screen.findByRole('region', { name: 'Shop statistics' });
      const s = within(stats);
      expect(s.getByText('Real deals').nextSibling?.textContent).toBe('61%');
      expect(s.getByText('Deals to avoid').nextSibling?.textContent).toBe('23');
      expect(s.getByText('Was price raised').nextSibling?.textContent).toBe('9');
      expect(s.getByText('Marked Black Friday').nextSibling?.textContent).toBe('1,287');
    });

    it('a null real-deal percentage reads "Not enough judged yet", never 0%', async () => {
      const stats = { products: 10, judged: 0, good: 0, avoid: 0, wasRaised: 0, bfMarked: 0, realDealPct: null };
      mockApi({ '/api/shops/alpha': () => json(shopResponse({ stats })) });
      renderAt('/shops/alpha');
      const region = await screen.findByRole('region', { name: 'Shop statistics' });
      expect(within(region).getByText('Real deals').nextSibling?.textContent).toBe('Not enough judged yet');
      expect(region.textContent).not.toMatch(/\b0%/);
    });

    it('lists rises and drops as accessible tables with links, dates and prices', async () => {
      mockApi({ '/api/shops/alpha': () => json(shopResponse()) });
      renderAt('/shops/alpha');
      const rises = await screen.findByRole('table', { name: 'Top price rises' });
      expect(within(rises).getAllByRole('columnheader').every((th) => th.getAttribute('scope') === 'col')).toBe(true);
      const row = within(rises).getByRole('link', { name: 'Change 21' }).closest('tr')!;
      expect(within(row).getByRole('link').getAttribute('href')).toBe('/product/s21?seller=21');
      expect(row.textContent).toContain('€709.00');
      expect(row.textContent).toContain('€799.00');
      expect(row.textContent).toContain('20 Oct');
      expect(row.textContent).toContain('22 Oct');
      expect(row.textContent).toContain('+12.7%');
      const drops = screen.getByRole('table', { name: 'Top real drops' });
      expect(within(drops).getByText('-6%')).toBeTruthy();
    });

    it('shows "Not shown" instead of NaN for a stat that is not a finite number', async () => {
      const stats = { products: 10, judged: 5, good: 3, avoid: Number.NaN, wasRaised: 1, bfMarked: 2, realDealPct: 60 };
      // NaN becomes null in JSON, which the client must treat as not shown
      mockApi({ '/api/shops/alpha': () => json(shopResponse({ stats })) });
      renderAt('/shops/alpha');
      const region = await screen.findByRole('region', { name: 'Shop statistics' });
      expect(within(region).getByText('Deals to avoid').nextSibling?.textContent).toBe('Not shown');
      expect(region.textContent).not.toMatch(/NaN|null/);
    });

    it('the real-deals number has no colour judgement', async () => {
      mockApi({ '/api/shops/alpha': () => json(shopResponse()) });
      renderAt('/shops/alpha');
      const region = await screen.findByRole('region', { name: 'Shop statistics' });
      const value = within(region).getByText('Real deals').nextSibling as HTMLElement;
      expect(value.className).not.toMatch(/text-good|text-bad/);
    });

    it('prints no percentage for a change row without both prices', async () => {
      const bad = shopResponse({ rises: [change(21, { fromCents: 0, pct: 12.7 })], drops: [change(31, { toCents: 0, pct: -100 })] });
      mockApi({ '/api/shops/alpha': () => json(bad) });
      renderAt('/shops/alpha');
      const rises = await screen.findByRole('table', { name: 'Top price rises' });
      const drops = screen.getByRole('table', { name: 'Top real drops' });
      expect(drops.textContent).not.toContain('-100%');
      expect(rises.textContent).not.toContain('12.7%');
      for (const t of [rises, drops]) {
        const cells = within(t.querySelector('tbody tr') as HTMLElement).getAllByText('Price not shown by the shop');
        expect(cells.length).toBeGreaterThan(0);
      }
    });

    it('never shows €0.00 for a change without a valid price', async () => {
      const bad = shopResponse({ rises: [change(21, { fromCents: 0, toCents: 79900 })], drops: [change(31, { toCents: 0, pct: -100 })] });
      mockApi({ '/api/shops/alpha': () => json(bad) });
      renderAt('/shops/alpha');
      await screen.findByRole('table', { name: 'Top price rises' });
      expect(document.body.textContent).not.toContain('€0.00');
      expect(screen.getAllByText('Price not shown by the shop').length).toBeGreaterThan(0);
    });

    it('names the stored raise window when there are no changes (M4)', async () => {
      mockApi({ '/api/shops/alpha': () => json(shopResponse({ rises: [], drops: [], raiseWindowDays: 9 })) });
      renderAt('/shops/alpha');
      expect(await screen.findByText('No price rises in the last 9 days.')).toBeTruthy();
      expect(screen.getByText('No price drops in the last 9 days.')).toBeTruthy();
    });

    it('states facts when there are no changes', async () => {
      mockApi({ '/api/shops/alpha': () => json(shopResponse({ rises: [], drops: [] })) });
      renderAt('/shops/alpha');
      expect(await screen.findByText('No price rises in the last 14 days.')).toBeTruthy();
      expect(screen.getByText('No price drops in the last 14 days.')).toBeTruthy();
      expect(screen.queryByRole('table')).toBeNull();
    });
  });

  it('an unknown shop shows a not-found state with one h1 and a link to /shops', async () => {
    mockApi({ '/api/shops/nope': () => json({ error: 'unknown shop' }, 404) });
    renderAt('/shops/nope');
    await screen.findByText(/No shop is listed under that address/);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('link', { name: /All shops/ }).getAttribute('href')).toBe('/shops');
  });

  it('a malformed slug (400) is a not-found state too', async () => {
    mockApi({ '/api/shops/BAD': () => json({ error: 'x' }, 400) });
    renderAt('/shops/BAD');
    await screen.findByText(/No shop is listed under that address/);
  });

  it('a server error offers a retry and keeps one h1', async () => {
    const fn = mockApi({ '/api/shops/alpha': () => json({ error: 'internal error' }, 500) });
    renderAt('/shops/alpha');
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    fn.mockImplementation(async () => json(shopResponse()));
    fireEvent.click(retry);
    expect(await screen.findByRole('region', { name: 'Good deals here' })).toBeTruthy();
  });
});
