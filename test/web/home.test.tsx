// @vitest-environment jsdom
// Home and search pages against a mocked read API (fetch stub).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';
import type { Card, GroupResult } from '@/lib/api';

/** matchMedia that answers (min-width: Npx) for the given viewport width; everything else is false. */
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

const PHRASES = { morning: ['Is that deal *real*?'], afternoon: ['Is that deal *real*?'], evening: ['Is that deal *real*?'], late: ['Is that deal *real*?'], bfweek: ['Is that deal *real*?'] };

const goodCards = () => [1, 2, 3, 4, 5, 6].map((id) => card(id));
const avoidCards = () =>
  [11, 12, 13, 14, 15, 16].map((id) =>
    card(id, { verdict: 'avoid', priceCents: 79900, wasCents: 88900, raisedFrom: { priceCents: 70900, at: '2026-10-20' } }),
  );

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Stubs fetch with one handler per API path; returns the mock for call assertions. */
function mockApi(routes: Record<string, Route>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const route = routes[url.pathname];
    return route ? route(url, init) : json({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const home = (good: Card[] = goodCards(), avoid: Card[] = avoidCards(), minHistoryDays = 14): Route => () =>
  json({ phrases: PHRASES, good, avoid, minHistoryDays });

const searchCalls = (fn: ReturnType<typeof mockApi>) =>
  fn.mock.calls.map(([input]) => new URL(String(input), 'http://localhost')).filter((u) => u.pathname === '/api/search');

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const section = (name: string) => screen.getByRole('region', { name });
const cardsIn = (el: HTMLElement) => within(el).getAllByRole('article');

beforeEach(() => {
  localStorage.clear();
  setViewport(1024);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('home', () => {
  it('renders the headline as the only h1, then 6 good and 6 avoid cards on desktop', async () => {
    mockApi({ '/api/home': home() });
    renderAt('/');
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(12));
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]!.textContent).toBe('Is that deal real?');
    expect(cardsIn(section('Good deals'))).toHaveLength(6);
    expect(cardsIn(section('Deals to avoid'))).toHaveLength(6);
    expect(within(section('Good deals')).getByRole('link', { name: /See all good deals/ }).getAttribute('href')).toBe('/deals?type=good');
    expect(within(section('Deals to avoid')).getByRole('link', { name: /See all deals to avoid/ }).getAttribute('href')).toBe('/deals?type=avoid');
  });

  it('on a phone shows one list with a Good / Avoid switch', async () => {
    setViewport(375);
    mockApi({ '/api/home': home() });
    renderAt('/');
    const goodTab = await screen.findByRole('tab', { name: 'Good deals' });
    const avoidTab = screen.getByRole('tab', { name: 'Deals to avoid' });
    expect(goodTab.getAttribute('aria-selected')).toBe('true');
    const panel = () => screen.getByRole('tabpanel');
    expect(cardsIn(panel())).toHaveLength(6);
    expect(within(panel()).getByText('Product 1')).toBeTruthy();
    fireEvent.mouseDown(avoidTab, { button: 0 });
    await waitFor(() => expect(avoidTab.getAttribute('aria-selected')).toBe('true'));
    expect(cardsIn(panel())).toHaveLength(6);
    expect(within(panel()).getByText('Product 11')).toBeTruthy();
  });

  it('a card links to its product and its shop', async () => {
    mockApi({ '/api/home': home() });
    renderAt('/');
    const first = (await screen.findAllByRole('article'))[0]!;
    expect(within(first).getByRole('link', { name: 'Product 1' }).getAttribute('href')).toBe('/p/1');
    expect(within(first).getByRole('link', { name: 'Alpha Shop' }).getAttribute('href')).toBe('/shops/alpha');
  });

  it('a card without a price says "Price not shown by the shop" and never shows €0.00', async () => {
    mockApi({ '/api/home': home([card(1)], [card(2, { verdict: 'avoid', priceCents: null, wasCents: null })]) });
    renderAt('/');
    const avoid = await waitFor(() => cardsIn(section('Deals to avoid'))[0]!);
    expect(within(avoid).getByText('Price not shown by the shop')).toBeTruthy();
    expect(document.body.textContent).not.toContain('€0.00');
  });

  it('Simple mode hides the reason, Advanced shows it', async () => {
    mockApi({ '/api/home': home([card(1, { reason: '€20.00 below its lowest price in the 30 days before 1 Nov (€149.00).' })], []) });
    renderAt('/');
    await screen.findByText('Product 1');
    expect(screen.queryByText(/below its lowest price/)).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Advanced mode' }));
    expect(screen.getByText('€20.00 below its lowest price in the 30 days before 1 Nov (€149.00).')).toBeTruthy();
  });

  it('a good card shows the real deal tag with the price and the was price', async () => {
    mockApi({ '/api/home': home([card(1, { priceCents: 12999, wasCents: 13999 })], []) });
    renderAt('/');
    const c = (await screen.findAllByRole('article'))[0]!;
    expect(within(c).getByRole('img', { name: /Real deal/ })).toBeTruthy();
    expect(within(c).getByText('€129.99')).toBeTruthy();
    expect(within(c).getByText(/€139\.99/).closest('s')).not.toBeNull();
  });

  it('an avoid card shows the raise on its tag and as a fact line in Simple mode', async () => {
    mockApi({ '/api/home': home([], [card(11, { verdict: 'avoid', priceCents: 79900, wasCents: 88900, raisedFrom: { priceCents: 70900, at: '2026-10-20' } })]) });
    renderAt('/');
    const c = await waitFor(() => cardsIn(section('Deals to avoid'))[0]!);
    expect(within(c).getByRole('img', { name: 'Raised from €709.00 to €799.00' })).toBeTruthy();
    expect(within(c).getByText('Price on 20 Oct: €709.00')).toBeTruthy();
  });

  it('an avoid card with a raised was price says so on its tag', async () => {
    mockApi({ '/api/home': home([], [card(11, { verdict: 'avoid', priceCents: 24900, wasCents: 39900, wasRaisedFromCents: 29900 })]) });
    renderAt('/');
    const c = await waitFor(() => cardsIn(section('Deals to avoid'))[0]!);
    expect(within(c).getByRole('img', { name: 'WAS RAISED: from €299.00 to €399.00' })).toBeTruthy();
    expect(within(c).getByText('Was price raised from €299.00 to €399.00')).toBeTruthy();
  });

  it('marks Black Friday cards, and a Black Friday avoid card is unmistakable', async () => {
    mockApi({
      '/api/home': home(
        [card(1, { bf: true })],
        [card(11, { bf: true, verdict: 'avoid', priceCents: 79900, raisedFrom: { priceCents: 70900, at: '2026-10-20' } }), card(12, { verdict: 'avoid', priceCents: 5000, raisedFrom: { priceCents: 4000, at: '2026-10-19' } })],
      ),
    });
    renderAt('/');
    const good = await waitFor(() => cardsIn(section('Good deals'))[0]!);
    expect(within(good).getByText('Black Friday')).toBeTruthy();
    const [bfAvoid, plainAvoid] = cardsIn(section('Deals to avoid'));
    expect(within(bfAvoid!).getByText('Marked Black Friday, price raised')).toBeTruthy();
    expect(bfAvoid!.getAttribute('data-alarm')).toBe('true');
    expect(within(plainAvoid!).queryByText(/Black Friday/)).toBeNull();
    expect(plainAvoid!.getAttribute('data-alarm')).toBeNull();
  });

  it('none and insufficient cards get no tag, only the price', async () => {
    mockApi({ '/api/home': home([card(1, { verdict: 'none' }), card(2, { verdict: 'insufficient' })], []) });
    renderAt('/');
    const cards = await waitFor(() => cardsIn(section('Good deals')));
    for (const c of cards) expect(within(c).queryByRole('img', { name: /Real deal|Raised|AVOID/i })).toBeNull();
    expect(within(cards[0]!).getByText('€100.01')).toBeTruthy();
  });

  it('renders shop text as text, never as HTML', async () => {
    mockApi({ '/api/home': home([card(1, { title: '<img src=x onerror=alert(1)><b>Bold</b>', shop: '<i>Shop</i>' })], []) });
    renderAt('/');
    const c = (await screen.findAllByRole('article'))[0]!;
    expect(c.querySelector('b, i, img[src="x"]')).toBeNull();
    expect(within(c).getByText('<img src=x onerror=alert(1)><b>Bold</b>')).toBeTruthy();
  });

  it('with no verdicts yet explains why the lists are empty, with the stored minimum history', async () => {
    mockApi({ '/api/home': home([], [], 21) });
    renderAt('/');
    expect(await screen.findByText(/We need 21 days of prices before we judge a deal/)).toBeTruthy();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });

  it('when the API is down shows an error with a retry that loads again', async () => {
    let up = false;
    const fetchMock = mockApi({ '/api/home': (url) => (up ? home()(url) : json({ error: 'internal error' }, 500)) });
    renderAt('/');
    expect(await screen.findByText('Prices could not be loaded.')).toBeTruthy();
    // the headline still renders (fallback line)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    up = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(12));
    expect(fetchMock.mock.calls.filter(([i]) => String(i).startsWith('/api/home'))).toHaveLength(2);
  });

  it('shows a loading state with the same frame while the deals load, and always exactly one h1', async () => {
    let release!: () => void;
    mockApi({ '/api/home': (url) => new Promise((r) => (release = () => r(home()(url) as Response))) });
    renderAt('/');
    expect(screen.getByRole('status', { name: 'Loading deals' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading deals' })).toBeNull());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('a 200 answer with the wrong shape becomes the error state, not an endless load', async () => {
    mockApi({ '/api/home': () => json({}) });
    renderAt('/');
    expect(await screen.findByText('Prices could not be loaded.')).toBeTruthy();
  });

  it('aborts the request when the page unmounts', async () => {
    let signal: AbortSignal | undefined;
    mockApi({
      '/api/home': (_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
    });
    const view = renderAt('/');
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal!.aborted).toBe(false);
    view.unmount();
    expect(signal!.aborted).toBe(true);
  });
});

describe('home search box', () => {
  const groups = (q: string): GroupResult[] => [
    {
      canonicalId: 1,
      title: `${q} result`,
      items: [{ ...card(41, { title: `${q} result`, priceCents: 59900, shop: 'Beta', shopSlug: 'beta' }), possible: false, inStock: true, cheaper: null }],
    },
  ];

  it('typing "ip" waits for the debounce, then shows live results; one character calls nothing', async () => {
    const fn = mockApi({ '/api/home': home(), '/api/search': (url) => json({ results: groups(url.searchParams.get('q')!) }) });
    renderAt('/');
    const box = screen.getByRole('searchbox', { name: 'Search a product' });
    fireEvent.change(box, { target: { value: 'i' } });
    await sleep(350);
    expect(searchCalls(fn)).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Search results' })).toBeNull();

    fireEvent.change(box, { target: { value: 'ip' } });
    await sleep(100);
    expect(searchCalls(fn)).toHaveLength(0);
    const results = await screen.findByRole('region', { name: 'Search results' });
    await waitFor(() => expect(within(results).getByRole('link', { name: /ip result/ })).toBeTruthy());
    expect(within(results).getByRole('link', { name: /ip result/ }).getAttribute('href')).toBe('/p/41');
    expect(searchCalls(fn).map((u) => u.searchParams.get('q'))).toEqual(['ip']);
  });

  it('announces the search state in one status element that is there before any results', async () => {
    let down = false;
    mockApi({
      '/api/home': home(),
      '/api/search': (url) => (down ? json({ error: 'x' }, 500) : json({ results: url.searchParams.get('q') === 'zz' ? [] : groups('ip') })),
    });
    renderAt('/');
    const status = screen.getByTestId('search-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('');
    const box = screen.getByRole('searchbox', { name: 'Search a product' });
    fireEvent.change(box, { target: { value: 'ip' } });
    await waitFor(() => expect(status.textContent).toBe('Searching'));
    await waitFor(() => expect(status.textContent).toBe('1 product found'));
    fireEvent.change(box, { target: { value: 'zz' } });
    await waitFor(() => expect(status.textContent).toBe('No products match "zz"'));
    down = true;
    fireEvent.change(box, { target: { value: 'zzz' } });
    await waitFor(() => expect(status.textContent).toBe('Search is not available right now'));
    expect(screen.getByTestId('search-status')).toBe(status);
  });

  it('live results mark Black Friday rows, and a Black Friday avoid row says the price was raised', async () => {
    const row = (c: Card) => ({ canonicalId: null, title: c.title, items: [{ ...c, possible: false, inStock: true, cheaper: null }] });
    mockApi({
      '/api/home': home(),
      '/api/search': () =>
        json({
          results: [
            row(card(51, { title: 'Lenovo V15', verdict: 'avoid', bf: true, priceCents: 79900, raisedFrom: { priceCents: 70900, at: '2026-10-20' } })),
            row(card(52, { title: 'Razer keyboard', bf: true })),
          ],
        }),
    });
    renderAt('/');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search a product' }), { target: { value: 'le' } });
    const avoidRow = await screen.findByRole('link', { name: /Lenovo V15/ });
    expect(within(avoidRow).getByText('Marked Black Friday, price raised')).toBeTruthy();
    const goodRow = screen.getByRole('link', { name: /Razer keyboard/ });
    expect(within(goodRow).getByText('Black Friday')).toBeTruthy();
  });

  it('ignores a stale response: the earlier request is aborted and its late answer is dropped', async () => {
    const pending: { q: string; signal: AbortSignal | undefined; resolve: (r: Response) => void }[] = [];
    mockApi({
      '/api/home': home(),
      '/api/search': (url, init) => new Promise<Response>((resolve) => pending.push({ q: url.searchParams.get('q')!, signal: init?.signal ?? undefined, resolve })),
    });
    renderAt('/');
    const box = screen.getByRole('searchbox', { name: 'Search a product' });
    fireEvent.change(box, { target: { value: 'ip' } });
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(box, { target: { value: 'iphone' } });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]!.signal?.aborted).toBe(true);
    await act(async () => pending[1]!.resolve(json({ results: groups('iphone') })));
    await act(async () => pending[0]!.resolve(json({ results: groups('ip') })));
    const results = screen.getByRole('region', { name: 'Search results' });
    expect(within(results).getByRole('link', { name: /iphone result/ })).toBeTruthy();
    expect(within(results).queryByRole('link', { name: /^ip result/ })).toBeNull();
  });

  it('Enter goes to /search?q=', async () => {
    mockApi({ '/api/home': home(), '/api/search': () => json({ results: [] }) });
    renderAt('/');
    const box = screen.getByRole('searchbox', { name: 'Search a product' });
    fireEvent.change(box, { target: { value: 'dyson v15' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/search?q=dyson+v15'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Search');
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('dyson v15');
  });

  it('says so when nothing matches, and when search is down', async () => {
    let down = false;
    mockApi({ '/api/home': home(), '/api/search': () => (down ? json({ error: 'internal error' }, 500) : json({ results: [] })) });
    renderAt('/');
    const box = screen.getByRole('searchbox', { name: 'Search a product' });
    fireEvent.change(box, { target: { value: 'zzzz' } });
    expect(await screen.findByText('No products match "zzzz".')).toBeTruthy();
    down = true;
    fireEvent.change(box, { target: { value: 'zzzzz' } });
    expect(await screen.findByText('Search is not available right now.')).toBeTruthy();
  });
});

describe('search page', () => {
  type Cheaper = { id: number; shop: string; shopSlug: string; priceCents: number } | null;
  const item = (id: number, shop: string, priceCents: number | null, possible: boolean, extra: Partial<Card> = {}, cheaper: Cheaper = null) => ({
    ...card(id, { title: 'Lenovo IdeaPad Slim 5', shop, shopSlug: shop.toLowerCase(), priceCents, verdict: 'none', ...extra }),
    possible,
    inStock: true,
    cheaper,
  });

  it('has its own h1 and searches the query from the URL straight away', async () => {
    const fn = mockApi({ '/api/search': () => json({ results: [] }) });
    renderAt('/search?q=lenovo');
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Search']);
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('lenovo');
    expect(await screen.findByText('No products match "lenovo".')).toBeTruthy();
    expect(searchCalls(fn).map((u) => u.searchParams.get('q'))).toEqual(['lenovo']);
  });

  it('under 2 characters shows nothing and calls nothing', async () => {
    const fn = mockApi({ '/api/search': () => json({ results: [] }) });
    renderAt('/search?q=a');
    await sleep(350);
    expect(searchCalls(fn)).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Search results' })).toBeNull();
  });

  it('groups results by product, cheapest first, and shows the cheaper-elsewhere chip the API decided', async () => {
    mockApi({
      '/api/search': () =>
        json({
          results: [
            {
              canonicalId: 1,
              title: 'Lenovo IdeaPad Slim 5',
              items: [
                item(1, 'Beta', 60000, false),
                item(2, 'Alpha', 70000, false, {}, { id: 1, shop: 'Beta', shopSlug: 'beta', priceCents: 60000 }),
                item(3, 'Gamma', null, false),
              ],
            },
            // the client never works out a cheaper claim itself: no `cheaper` from the API, no chip
            { canonicalId: 2, title: 'Lenovo IdeaPad Slim 3', items: [item(4, 'Delta', 40000, true), item(5, 'Alpha', 45000, false)] },
          ],
        }),
    });
    renderAt('/search?q=lenovo');
    const results = await screen.findByRole('region', { name: 'Search results' });
    const groups = await waitFor(() => within(results).getAllByRole('article'));
    expect(groups).toHaveLength(2);
    const [g1, g2] = groups;
    expect(within(g1!).getByRole('heading', { level: 2 }).textContent).toBe('Lenovo IdeaPad Slim 5');
    const rows1 = within(g1!).getAllByRole('listitem');
    expect(rows1.map((r) => within(r).getAllByRole('link')[0]!.textContent)).toEqual(['Beta', 'Alpha', 'Gamma']);
    expect(within(rows1[0]!).queryByText(/Cheaper elsewhere/)).toBeNull();
    expect(within(rows1[1]!).getByText('Cheaper elsewhere: €600.00 at Beta')).toBeTruthy();
    expect(within(rows1[2]!).getByText('Price not shown by the shop')).toBeTruthy();
    expect(within(rows1[2]!).queryByText(/Cheaper elsewhere/)).toBeNull();

    expect(within(g2!).queryByText(/Cheaper elsewhere/)).toBeNull();
    const rows2 = within(g2!).getAllByRole('listitem');
    expect(within(rows2[0]!).getByText('Possibly the same product')).toBeTruthy();
    expect(within(rows2[1]!).queryByText('Possibly the same product')).toBeNull();
  });

  it('shows the verdict of each row: a raised price is visible, Black Friday rows are marked', async () => {
    mockApi({
      '/api/search': () =>
        json({
          results: [
            {
              canonicalId: null,
              title: 'Lenovo V15',
              items: [item(1, 'AtoZ', 79900, false, { verdict: 'avoid', bf: true, raisedFrom: { priceCents: 70900, at: '2026-10-20' } })],
            },
          ],
        }),
    });
    renderAt('/search?q=lenovo');
    const row = await screen.findByRole('listitem');
    expect(within(row).getByText('Marked Black Friday, price raised')).toBeTruthy();
    expect(within(row).getByText('Price on 20 Oct: €709.00')).toBeTruthy();
  });

  it('shows an error with a retry when search is down', async () => {
    let down = true;
    mockApi({ '/api/search': () => (down ? json({ error: 'internal error' }, 500) : json({ results: [] })) });
    renderAt('/search?q=lenovo');
    expect(await screen.findByText('Search is not available right now.')).toBeTruthy();
    down = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No products match "lenovo".')).toBeTruthy();
  });

  it('the debounce fires at 250 ms, not at 249 ms', () => {
    vi.useFakeTimers();
    try {
      const fn = mockApi({ '/api/search': () => json({ results: [] }) });
      renderAt('/search');
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ip' } });
      act(() => vi.advanceTimersByTime(249));
      expect(searchCalls(fn)).toHaveLength(0);
      act(() => vi.advanceTimersByTime(1));
      expect(searchCalls(fn).map((u) => u.searchParams.get('q'))).toEqual(['ip']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces the search state in one persistent status element', async () => {
    mockApi({ '/api/search': () => json({ results: [{ canonicalId: null, title: 'Lenovo', items: [item(1, 'Beta', 60000, false)] }] }) });
    renderAt('/search');
    const status = screen.getByTestId('search-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'lenovo' } });
    await waitFor(() => expect(status.textContent).toBe('1 product found'));
    expect(screen.getByTestId('search-status')).toBe(status);
  });

  it('typing updates the URL after the debounce', async () => {
    mockApi({ '/api/search': () => json({ results: [] }) });
    renderAt('/search');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'air fryer' } });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/search?q=air+fryer'));
  });
});
