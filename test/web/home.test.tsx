// @vitest-environment jsdom
// Home and search pages against a mocked read API (fetch stub).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';
import type { Card, ProductResult } from '@/lib/api';

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
    logoUrl: null,
    logoAspect: null,
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
  it('renders the headline as the only h1, then three good and three avoid cards at a time on desktop', async () => {
    mockApi({ '/api/home': home() });
    renderAt('/');
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(6));
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]!.textContent).toBe('Is that deal real?');
    expect(cardsIn(section('Good deals'))).toHaveLength(3);
    expect(cardsIn(section('Deals to avoid'))).toHaveLength(3);
    expect(within(section('Good deals')).getByRole('link', { name: /See all good deals/ }).getAttribute('href')).toBe('/deals?type=good');
    expect(within(section('Deals to avoid')).getByRole('link', { name: /See all deals to avoid/ }).getAttribute('href')).toBe('/deals?type=avoid');
  });

  it('each row pages through its deals with previous and next, shows the set as bars, and can be paused', async () => {
    mockApi({ '/api/home': home() });
    renderAt('/');
    const row = await waitFor(() => section('Good deals'));
    await waitFor(() => expect(cardsIn(row)).toHaveLength(3));
    expect(within(row).getByRole('img', { name: 'Showing set 1 of 2' })).toBeTruthy();
    expect(within(row).getByText('Product 1')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Next good deals' }));
    await waitFor(() => expect(within(row).getByText('Product 4')).toBeTruthy());
    expect(within(row).getByRole('img', { name: 'Showing set 2 of 2' })).toBeTruthy();
    const pause = within(row).getByRole('button', { name: 'Pause good deals' });
    expect(pause.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pause);
    expect(within(row).getByRole('button', { name: 'Play good deals' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('the first screen is the search alone: headline, search and the scroll cue, the deals below it', async () => {
    mockApi({ '/api/home': home() });
    renderAt('/');
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(6));
    const hero = screen.getByTestId('home-hero');
    expect(hero.className.split(/\s+/)).toContain('hero');
    expect(hero.className).toContain('justify-center');
    expect(hero.contains(screen.getByRole('heading', { level: 1 }))).toBe(true);
    expect(hero.contains(screen.getByRole('searchbox', { name: 'Search a product' }))).toBe(true);
    expect(hero.contains(screen.getByTestId('search-status'))).toBe(true);
    expect(hero.contains(section('Good deals'))).toBe(false);
    expect(within(hero).getByRole('link', { name: /Scroll to see this week's verdicts/ }).getAttribute('href')).toBe('#deals');
  });

  it('a Try example fills the search', async () => {
    mockApi({ '/api/home': home(), '/api/search': () => json({ results: [] }) });
    renderAt('/');
    const hero = screen.getByTestId('home-hero');
    const example = within(hero)
      .getAllByRole('button')
      .find((b) => b.textContent && b.textContent !== 'Check')!;
    fireEvent.click(example);
    expect((screen.getByRole('searchbox', { name: 'Search a product' }) as HTMLInputElement).value).toBe(example.textContent);
  });

  it('the main search types an example as an aria-hidden overlay, the name stays "Search a product"', async () => {
    mockApi({ '/api/home': home() });
    renderAt('/');
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(6));
    expect(screen.getByTestId('search-example').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('searchbox', { name: 'Search a product' }).getAttribute('placeholder')).toBeNull();
  });

  it('on a phone shows one list with a Good / Avoid switch', async () => {
    setViewport(375);
    mockApi({ '/api/home': home() });
    renderAt('/');
    const type = await screen.findByRole('radiogroup', { name: 'Deal type' });
    const goodTab = within(type).getByRole('radio', { name: 'Good deals' });
    const avoidTab = within(type).getByRole('radio', { name: 'Deals to avoid' });
    expect(goodTab.getAttribute('aria-checked')).toBe('true');
    const panel = () => screen.getByRole('tabpanel');
    expect(cardsIn(panel())).toHaveLength(3);
    expect(within(panel()).getByText('Product 1')).toBeTruthy();
    fireEvent.click(avoidTab);
    await waitFor(() => expect(avoidTab.getAttribute('aria-checked')).toBe('true'));
    expect(cardsIn(panel())).toHaveLength(3);
    expect(within(panel()).getByText('Product 11')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause deals to avoid' })).toBeTruthy();
  });

  it('a card links to its product and its shop', async () => {
    mockApi({ '/api/home': home() });
    renderAt('/');
    const first = (await screen.findAllByRole('article'))[0]!;
    expect(within(first).getByRole('link', { name: 'Product 1' }).getAttribute('href')).toBe('/product/s1?seller=1');
    expect(within(first).getByRole('link', { name: 'Alpha Shop' }).getAttribute('href')).toBe('/shops/alpha');
  });

  it('a card without a price says "Price not shown by the shop" and never shows €0.00', async () => {
    mockApi({ '/api/home': home([card(1)], [card(2, { verdict: 'avoid', priceCents: null, wasCents: null })]) });
    renderAt('/');
    const avoid = await waitFor(() => cardsIn(section('Deals to avoid'))[0]!);
    expect(within(avoid).getByText('Price not shown by the shop')).toBeTruthy();
    expect(document.body.textContent).not.toContain('€0.00');
  });

  it("focusing a card opens its panel: why, the shop's claim against our check, price history and the shop", async () => {
    mockApi({ '/api/home': home([card(1, { priceCents: 14900, wasCents: 16900, reason: '€20.00 below its lowest price in the 30 days before 1 Nov (€169.00).' })], []) });
    renderAt('/');
    const c = await waitFor(() => cardsIn(section('Good deals'))[0]!);
    // closed: the panel is hidden and out of the tab order
    expect(within(c).queryByRole('link', { name: 'See price history' })).toBeNull();
    fireEvent.focus(within(c).getByRole('link', { name: 'Product 1' }));
    expect(c.getAttribute('data-active')).toBe('true');
    expect(within(c).getByText('Why it is a good deal')).toBeTruthy();
    expect(within(c).getByText('€20.00 below its lowest price in the 30 days before 1 Nov (€169.00).')).toBeTruthy();
    expect(within(c).getByText('12% off')).toBeTruthy();
    expect(within(c).getByText("Shop's claim")).toBeTruthy();
    expect(within(c).getByText('Real deal')).toBeTruthy();
    expect(within(c).getByRole('link', { name: 'See price history' }).getAttribute('href')).toBe('/product/s1?seller=1');
    expect(within(c).getByRole('link', { name: 'Alpha Shop rating' }).getAttribute('href')).toBe('/shops/alpha');
  });

  it('a good card says how much off and that it is real, with the price and the was price', async () => {
    mockApi({ '/api/home': home([card(1, { priceCents: 12999, wasCents: 13999 })], []) });
    renderAt('/');
    const c = (await screen.findAllByRole('article'))[0]!;
    expect(within(c).getByText('7% off, real deal')).toBeTruthy();
    expect(within(c).getByText('€129.99')).toBeTruthy();
    expect(within(c).getByText(/€139\.99/).closest('s')).not.toBeNull();
  });

  it('an avoid card says the price was raised, and its why is the change in Simple mode', async () => {
    mockApi({ '/api/home': home([], [card(11, { verdict: 'avoid', priceCents: 79900, wasCents: 88900, raisedFrom: { priceCents: 70900, at: '2026-10-20' } })]) });
    renderAt('/');
    const c = await waitFor(() => cardsIn(section('Deals to avoid'))[0]!);
    expect(within(c).getByText('Price raised')).toBeTruthy();
    expect(within(c).getByText('Price on 20 Oct: €709.00')).toBeTruthy();
    expect(within(c).getByText('Not real')).toBeTruthy();
  });

  it('an avoid card with a raised was price says so', async () => {
    mockApi({ '/api/home': home([], [card(11, { verdict: 'avoid', priceCents: 24900, wasCents: 39900, wasRaisedFromCents: 29900 })]) });
    renderAt('/');
    const c = await waitFor(() => cardsIn(section('Deals to avoid'))[0]!);
    expect(within(c).getByText('Was price raised')).toBeTruthy();
    expect(within(c).getByText('Was price raised from €299.00 to €399.00')).toBeTruthy();
  });

  it('Advanced mode gives the verdict sentence as the why of an avoid card', async () => {
    mockApi({ '/api/home': home([], [card(11, { verdict: 'avoid', priceCents: 79900, raisedFrom: { priceCents: 70900, at: '2026-10-20' }, reason: 'Price went up before the sale.' })]) });
    renderAt('/');
    const c = await waitFor(() => cardsIn(section('Deals to avoid'))[0]!);
    expect(within(c).queryByText('Price went up before the sale.')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Advanced' }));
    expect(within(c).getByText('Price went up before the sale.')).toBeTruthy();
  });

  it('marks Black Friday cards, and a Black Friday avoid card is flagged', async () => {
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
    expect(within(bfAvoid!).getByText('Black Friday')).toBeTruthy();
    expect(bfAvoid!.getAttribute('data-alarm')).toBe('true');
    expect(within(plainAvoid!).queryByText(/Black Friday/)).toBeNull();
    expect(plainAvoid!.getAttribute('data-alarm')).toBeNull();
  });

  it('none and insufficient cards get no badge, only the price', async () => {
    mockApi({ '/api/home': home([card(1, { verdict: 'none' }), card(2, { verdict: 'insufficient' })], []) });
    renderAt('/');
    const cards = await waitFor(() => cardsIn(section('Good deals')));
    for (const c of cards) expect(within(c).queryByText(/real deal|raised|not real|to avoid/i)).toBeNull();
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
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(6));
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
  const result = (key: string, extra: Partial<ProductResult> = {}): ProductResult => ({
    key,
    name: 'Thing',
    specs: null,
    priceCents: 59900,
    inStock: true,
    shops: 1,
    shop: 'Beta',
    logoUrl: null,
    logoAspect: null,
    bf: false,
    imageUrl: null,
    good: 0,
    avoid: 0,
    option: null,
    ...extra,
  });
  const groups = (q: string): ProductResult[] => [result('c1', { name: `${q} result` })];

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
    expect(within(results).getByRole('link', { name: /ip result/ }).getAttribute('href')).toBe('/product/c1');
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

  it('live results mark Black Friday rows, and a seller whose deal is one to avoid', async () => {
    mockApi({
      '/api/home': home(),
      '/api/search': () => json({ results: [result('s51', { name: 'Lenovo V15', avoid: 1, bf: true, priceCents: 79900 }), result('s52', { name: 'Razer keyboard', good: 1, bf: true })] }),
    });
    renderAt('/');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search a product' }), { target: { value: 'le' } });
    const avoidRow = await screen.findByRole('link', { name: /Lenovo V15/ });
    expect(within(avoidRow).getByText('Deal to avoid')).toBeTruthy();
    expect(within(avoidRow).getByText('Black Friday')).toBeTruthy();
    const goodRow = screen.getByRole('link', { name: /Razer keyboard/ });
    expect(within(goodRow).getByText('Real deal')).toBeTruthy();
    expect(within(goodRow).getByText('Black Friday')).toBeTruthy();
  });

  it('a product sold by several shops is one live row with its lowest price and shop count', async () => {
    mockApi({
      '/api/home': home(),
      '/api/search': () => json({ results: [result('c9', { name: 'Lenovo IdeaPad Slim 3', shops: 2, shop: null, priceCents: 39900 })] }),
    });
    renderAt('/');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search a product' }), { target: { value: 'lenovo' } });
    const row = await screen.findByRole('link', { name: /Lenovo IdeaPad Slim 3/ });
    expect(row.getAttribute('href')).toBe('/product/c9');
    expect(row.textContent).toContain('2 shops');
    expect(row.textContent).toContain('€399.00');
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
  const product = (key: string, extra: Partial<ProductResult> = {}): ProductResult => ({
    key,
    name: 'Lenovo IdeaPad Slim 5',
    specs: null,
    priceCents: 60000,
    inStock: true,
    shops: 1,
    shop: 'Beta',
    logoUrl: null,
    logoAspect: null,
    bf: false,
    imageUrl: null,
    good: 0,
    avoid: 0,
    option: null,
    ...extra,
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

  it('shows one card per product in the order the API gives, with its lowest price and number of shops', async () => {
    mockApi({
      '/api/search': () =>
        json({
          results: [
            product('c1', { name: 'Lenovo IdeaPad Slim 5', specs: '16GB RAM', priceCents: 60000, shops: 3, shop: null }),
            product('s5', { name: 'Lenovo IdeaPad Slim 3', priceCents: 45000, shops: 1, shop: 'Alpha' }),
          ],
        }),
    });
    renderAt('/search?q=lenovo');
    const results = await screen.findByRole('region', { name: 'Search results' });
    const cards = await waitFor(() => within(results).getAllByRole('article'));
    expect(cards.map((c) => within(c).getByRole('heading', { level: 2 }).textContent)).toEqual(['Lenovo IdeaPad Slim 5 · 16GB RAM', 'Lenovo IdeaPad Slim 3']);
    expect(cards[0]!.textContent).toContain('from €600.00 at 3 shops');
    expect(cards[1]!.textContent).toContain('at Alpha');
    expect(within(cards[1]!).getByRole('link').getAttribute('href')).toBe('/product/s5');
    // a product is one card: no per-shop rows, no cheaper chip (the product page lists every seller)
    expect(within(results).queryAllByRole('listitem')).toHaveLength(0);
    expect(within(results).queryByText(/Cheaper elsewhere/)).toBeNull();
  });

  it('shows the verdicts of the sellers and Black Friday on the card', async () => {
    mockApi({ '/api/search': () => json({ results: [product('s1', { name: 'Lenovo V15', avoid: 1, good: 0, bf: true, shop: 'AtoZ' })] }) });
    renderAt('/search?q=lenovo');
    const card = await screen.findByRole('article');
    expect(within(card).getByText('Deal to avoid')).toBeTruthy();
    expect(within(card).getByText('Black Friday')).toBeTruthy();
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
    mockApi({ '/api/search': () => json({ results: [product('s1', { name: 'Lenovo' })] }) });
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
