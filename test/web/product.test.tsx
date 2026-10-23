// @vitest-environment jsdom
// Product page (web/src/pages/Product.tsx, design Part 3) against a mocked read API: one product, every seller.
// Alpha has the Lenovo case: €709.00 until 21 Oct, €799.00 on 22 Oct while marked Black Friday (+€90.00, +12.7%).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';
import type { HistoryObs, ProductPage, SellerView } from '@/lib/api';
import { dayRows, lastDays } from '@/lib/history';

/** matchMedia: (min-width: Npx) for a 1024px viewport, and prefers-reduced-motion when `reduced`. */
function setMedia(reduced = false): void {
  window.matchMedia = ((query: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    const matches = min ? 1024 >= Number(min[1]) : query.includes('prefers-reduced-motion') ? reduced : false;
    return {
      matches,
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

const REP = 70;
const SMALL = 71;

/** 20:00 Malta time (18:00 UTC in October) on a YYYY-MM-DD day. */
function obs(productId: number, day: string, price: number | null, was: number | null, bf: boolean): HistoryObs {
  return { productId, at: `${day}T18:00:00.000Z`, price, was, inStock: true, bf };
}

function daysFrom(start: string, n: number): string[] {
  const t = Date.parse(`${start}T12:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(t + i * 86_400_000).toISOString().slice(0, 10));
}

/** Alpha's Black variant (its verdict's): 23 Sep to 21 Oct at €709.00 (was €739.00, marked from 21 Oct), €799.00 on 22 Oct. */
const lenovoHistory: HistoryObs[] = [
  ...daysFrom('2026-09-23', 29).map((d) => obs(REP, d, 70900, 73900, d === '2026-10-21')),
  obs(REP, '2026-10-22', 79900, 88900, true),
];
/** Alpha's Grey variant: €759.00 every day from 13 Oct. */
const smallHistory = daysFrom('2026-10-13', 10).map((d) => obs(SMALL, d, 75900, null, false));
/** Beta: €699.00 for the last 5 days. */
const betaHistory = daysFrom('2026-10-18', 5).map((d) => obs(80, d, 69900, null, false));

const alpha: SellerView = {
  id: 1,
  productId: REP,
  shop: 'Alpha',
  shopSlug: 'alpha',
  title: 'LENOVO V15 G5 IRL 15.6" i5/16GB/512SSD',
  url: 'https://alpha.example/v15',
  priceCents: 79900,
  wasCents: 88900,
  inStock: true,
  bf: true,
  verdict: {
    label: 'avoid',
    reason: 'Price went from €709.00 on 21 Oct to €799.00 on 22 Oct while marked Black Friday.',
    facts: {
      low30: 70900,
      usual: 70900,
      claimedPct: -10.1,
      realPct: 12.7,
      raisedFrom: { price: 70900, at: '2026-10-21' },
      raisedTo: { price: 79900, at: '2026-10-22' },
      wasRaisedFrom: 73900,
      historyDays: 30,
      priceChanges: 1,
      wasChanges: 1,
      daysWorthBuying: 29,
      judged: true,
    },
  },
  cheaper: { id: 2, shop: 'Beta', shopSlug: 'beta', priceCents: 69900 },
};
const beta: SellerView = {
  id: 2,
  productId: 80,
  shop: 'Beta',
  shopSlug: 'beta',
  title: 'Lenovo V15 G5 Laptop',
  url: 'https://beta.example/p/v15',
  priceCents: 69900,
  wasCents: null,
  inStock: true,
  bf: false,
  verdict: { label: 'none', reason: 'Not marked Black Friday and no discount claimed.', facts: null },
  cheaper: null,
};
const gamma: SellerView = {
  id: 3,
  productId: 90,
  shop: 'Gamma',
  shopSlug: 'gamma',
  title: 'Lenovo V15 <b>G5</b>',
  url: 'javascript:alert(1)',
  priceCents: null,
  wasCents: null,
  inStock: false,
  bf: false,
  verdict: { label: 'insufficient', reason: 'Price not shown by the shop.', facts: null },
  cheaper: null,
};

function page(extra: Partial<ProductPage> = {}): ProductPage {
  return {
    key: 'c5',
    product: {
      key: 'c5',
      name: 'Lenovo V15 G5 IRL 15.6" Intel Core i5 Notebook',
      specs: '512GB, 16GB RAM',
      brand: 'Lenovo',
      imageUrl: null,
      category: 'laptops',
      attributes: [
        { key: 'screen_in', label: 'Screen', value: '15.6"' },
        { key: 'storage_gb', label: 'Storage', value: '512GB' },
      ],
    },
    sellers: [beta, alpha, gamma],
    cheapestId: 2,
    variants: [
      { id: REP, sellerId: 1, label: 'Black', priceCents: 79900, inStock: true },
      { id: SMALL, sellerId: 1, label: 'Grey', priceCents: 75900, inStock: false },
      { id: 80, sellerId: 2, label: 'black', priceCents: 69900, inStock: true },
      { id: 90, sellerId: 3, label: null, priceCents: null, inStock: false },
    ],
    history: [...lenovoHistory.map((h) => ({ ...h, sellerId: 1 })), ...smallHistory.map((h) => ({ ...h, sellerId: 1 })), ...betaHistory.map((h) => ({ ...h, sellerId: 2 }))].sort(
      (a, b) => a.at.localeCompare(b.at) || a.productId - b.productId,
    ),
    minHistoryDays: 14,
    raiseWindowDays: 14,
    ...extra,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** /api/product/:key answers with `answer`; /api/products/:id (the old listing page) with `listing`. */
function mockApi(answer: (key: string) => Response, listing: (id: string) => Response = () => json({ error: 'not found' }, 404)) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const m = /^\/api\/product\/(.*)$/.exec(url.pathname);
    if (m) return answer(m[1]!);
    const old = /^\/api\/products\/(.*)$/.exec(url.pathname);
    return old ? listing(old[1]!) : json({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname}</output>;
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

const TITLE = 'Lenovo V15 G5 IRL 15.6" Intel Core i5 Notebook · 512GB, 16GB RAM';

async function openProduct(data: ProductPage = page()) {
  mockApi(() => json(data));
  const view = renderAt('/product/c5');
  await screen.findByRole('heading', { level: 1, name: data.product.specs ? `${data.product.name} · ${data.product.specs}` : data.product.name });
  return view;
}

const sellerItem = (shop: string) => screen.getByRole('listitem', { name: shop });

/** Recharts sizes itself with ResizeObserver, which jsdom lacks. */
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  localStorage.clear();
  setMedia();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  // a fixed clock: 23 Oct 2026, 10:00 Malta. Only Date is faked, so timers and testing-library keep working.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T08:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

describe('day rows', () => {
  it('keeps the last observation of each Malta day for one variant, with the change against the previous day', () => {
    const rows = dayRows(
      [obs(REP, '2026-10-21', 70900, 73900, true), { ...obs(REP, '2026-10-22', 75000, null, true), at: '2026-10-22T06:00:00.000Z' }, obs(REP, '2026-10-22', 79900, 88900, true), obs(SMALL, '2026-10-22', 1, null, false)],
      REP,
      70900,
    );
    expect(rows.map((r) => [r.day, r.price, r.change])).toEqual([
      ['2026-10-21', 70900, null],
      ['2026-10-22', 79900, { cents: 9000, pct: 12.7 }],
    ]);
    expect(rows.map((r) => r.worth)).toEqual([true, false]);
  });

  it('puts 23:30 UTC on 21 Oct on 22 Oct (Malta time)', () => {
    const rows = dayRows([{ ...obs(REP, '2026-10-21', 70900, null, false), at: '2026-10-21T23:30:00.000Z' }], REP, null);
    expect(rows[0]!.day).toBe('2026-10-22');
    expect(rows[0]!.worth).toBeNull();
  });

  it('never compares against or from a missing price', () => {
    const rows = dayRows([obs(REP, '2026-10-20', 70900, null, false), obs(REP, '2026-10-21', null, null, false), obs(REP, '2026-10-22', 79900, null, false)], REP, 70900);
    expect(rows.map((r) => r.change)).toEqual([null, null, null]);
    expect(rows.map((r) => r.prevHidden)).toEqual([false, false, true]);
    expect(rows[1]!.worth).toBeNull();
  });

  it('lastDays keeps the days within the last n Malta days of the latest one', () => {
    const rows = dayRows(lenovoHistory, REP, 70900);
    expect(rows).toHaveLength(30);
    expect(lastDays(rows, 7).map((r) => r.day)).toEqual(daysFrom('2026-10-16', 7));
    expect(lastDays(rows, 30)).toHaveLength(30);
  });
});


describe('product page, Simple', () => {
  it('shows the clean name and specs as the one h1, the brand, and every seller in the order the API gives', async () => {
    await openProduct();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([TITLE]);
    expect(screen.getByText('Lenovo', { selector: 'p' })).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Shops selling this product' });
    expect(within(list).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Beta', 'Alpha', 'Gamma']);
    expect(screen.getByText('from €699.00 at 3 shops')).toBeTruthy();
  });

  it('highlights the cheapest seller', async () => {
    await openProduct();
    expect(sellerItem('Beta').getAttribute('data-cheapest')).toBe('true');
    expect(within(sellerItem('Beta')).getByText('Cheapest')).toBeTruthy();
    expect(sellerItem('Alpha').getAttribute('data-cheapest')).toBeNull();
    expect(within(sellerItem('Alpha')).queryByText('Cheapest')).toBeNull();
  });

  it("keeps each seller's own verdict: Alpha's raised tag, alarm and earlier price, Beta's sentence", async () => {
    await openProduct();
    const a = sellerItem('Alpha');
    expect(within(a).getByRole('img', { name: 'Raised from €709.00 to €799.00' })).toBeTruthy();
    expect(within(a).getByText('Marked Black Friday, price raised')).toBeTruthy();
    expect(within(a).getByText('Price on 21 Oct: €709.00')).toBeTruthy();
    expect(within(a).getByText(alpha.verdict.reason!)).toBeTruthy();
    expect(a.getAttribute('data-verdict')).toBe('avoid');
    const b = sellerItem('Beta');
    expect(within(b).queryByRole('img', { name: /Raised|Real deal/ })).toBeNull();
    expect(within(b).getByText(beta.verdict.reason!)).toBeTruthy();
    expect(within(b).queryByText('Marked Black Friday, price raised')).toBeNull();
  });

  it("shows each seller's price and was price, and never €0.00", async () => {
    await openProduct();
    // the price line (the raised tag repeats the price in its drawing)
    expect(within(sellerItem('Alpha')).getAllByText('€799.00').length).toBeGreaterThan(0);
    expect(within(sellerItem('Alpha')).getByText('€889.00')).toBeTruthy();
    const g = sellerItem('Gamma');
    expect(within(g).getByText('Price not shown by the shop')).toBeTruthy();
    expect(within(g).getByText('Out of stock')).toBeTruthy();
    expect(document.body.textContent).not.toContain('€0.00');
  });

  it('names the cheaper seller the API decided (R36), and nothing more', async () => {
    await openProduct();
    expect(sellerItem('Alpha').textContent).toContain('Cheaper at Beta, €699.00');
    expect(within(sellerItem('Beta')).queryByText(/Cheaper at/)).toBeNull();
  });

  it('links to each shop page in a new tab, only for web addresses', async () => {
    await openProduct();
    const link = within(sellerItem('Alpha')).getByRole('link', { name: /^View on Alpha/ });
    expect(link.textContent).toContain('(opens in a new tab)');
    expect(link.getAttribute('href')).toBe('https://alpha.example/v15');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(within(sellerItem('Gamma')).queryByRole('link', { name: /View on/ })).toBeNull();
  });

  it("has a \"Something wrong?\" button per seller for that seller's listing (R20)", async () => {
    await openProduct();
    const button = within(sellerItem('Alpha')).getByRole('button', { name: /^Something wrong\?/ });
    expect(button.getAttribute('data-report-target')).toBe(`product:${REP}`);
    expect(within(sellerItem('Beta')).getByRole('button', { name: /^Something wrong\?/ }).getAttribute('data-report-target')).toBe('product:80');
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Something wrong?' })).toBeTruthy();
    expect(within(dialog).getByText(`${alpha.title} at Alpha`)).toBeTruthy();
  });

  it('renders shop text as text', async () => {
    await openProduct();
    const g = sellerItem('Gamma');
    expect(g.querySelector('b')).toBeNull();
    expect(within(g).getByText('Lenovo V15 <b>G5</b>')).toBeTruthy();
  });

  it('shows no chart, day table or attributes', async () => {
    await openProduct();
    expect(screen.queryByRole('table', { name: /Price by day/ })).toBeNull();
    expect(screen.queryByTestId('sellers-chart')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Product details' })).toBeNull();
  });
});

describe('product page, variant options', () => {
  it('offers the options of every seller once (case aside), and none for a product with one option', async () => {
    await openProduct();
    const group = screen.getByRole('radiogroup', { name: 'Option' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['All', 'Black', 'Grey']);
    cleanup();
    await openProduct(page({ variants: [{ id: 80, sellerId: 2, label: 'Black', priceCents: 69900, inStock: true }] }));
    expect(screen.queryByRole('radiogroup', { name: 'Option' })).toBeNull();
    // the one option is named, so a shop that lists each colour on its own shows which one this is
    expect(screen.getByText('Option: Black')).toBeTruthy();
  });

  it("choosing an option lists the sellers that have it, at that option's price", async () => {
    await openProduct();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Option' })).getByRole('radio', { name: 'Grey' }));
    const list = screen.getByRole('list', { name: 'Shops selling this product' });
    expect(within(list).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Alpha']);
    const a = sellerItem('Alpha');
    expect(within(a).getByText('€759.00')).toBeTruthy();
    expect(within(a).getByText('Out of stock')).toBeTruthy();
    // the deal check is about another option of this listing: no tag, no alarm
    expect(within(a).queryByRole('img', { name: /Raised/ })).toBeNull();
    expect(within(a).getByText('Our deal check at Alpha is for Black.')).toBeTruthy();
    expect(screen.getByText('Shops that do not name this option are left out.')).toBeTruthy();
  });

  it('choosing Black keeps the verdict of the seller whose checked option it is', async () => {
    await openProduct();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Option' })).getByRole('radio', { name: 'Black' }));
    const list = screen.getByRole('list', { name: 'Shops selling this product' });
    expect(within(list).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Beta', 'Alpha']);
    expect(within(sellerItem('Alpha')).getByRole('img', { name: 'Raised from €709.00 to €799.00' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Option' })).getByRole('radio', { name: 'All' }));
    expect(within(list).getAllByRole('heading', { level: 3 })).toHaveLength(3);
  });
});

describe('product page, Advanced', () => {
  // the first import of Recharts is slow in the test runner; load it once up front
  beforeAll(async () => {
    await import('@/components/site/SellersChart');
  }, 30_000);
  beforeEach(() => localStorage.setItem('mode', 'advanced'));

  it('draws one line per seller with prices, each its verdict variant, named in a legend', async () => {
    await openProduct();
    const chart = await screen.findByTestId('sellers-chart');
    expect(chart.getAttribute('data-lines')).toBe('2');
    expect(chart.getAttribute('role')).toBe('img');
    const legend = screen.getByRole('list', { name: 'Chart lines' });
    expect(within(legend).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Beta', 'Alpha (Black)']);
  });

  it('never mixes variants: choosing Grey draws Alpha from the Grey readings', async () => {
    await openProduct();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Option' })).getByRole('radio', { name: 'Grey' }));
    const legend = await screen.findByRole('list', { name: 'Chart lines' });
    expect(within(legend).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Alpha (Grey)']);
  });

  it("shows the day table of the chosen seller: the cheapest first, another by choice, with R44's column", async () => {
    await openProduct();
    let table = await screen.findByRole('table', { name: /Price by day/ });
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    // Beta's verdict is none: no worth-buying column (R44)
    expect(within(table).queryByRole('columnheader', { name: 'Worth buying' })).toBeNull();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Shop for the price by day' })).getByRole('radio', { name: 'Alpha' }));
    table = await screen.findByRole('table', { name: /Price by day/ });
    const row = within(table).getByRole('row', { name: /22 Oct/ });
    expect(within(row).getByText('+€90.00')).toBeTruthy();
    expect(within(row).getByText('+12.7%')).toBeTruthy();
    expect(within(row).getByText('Marked')).toBeTruthy();
    expect(within(row).getByText('No')).toBeTruthy();
  });

  it('switching to 7 days keeps only the last 7 days in the table', async () => {
    await openProduct();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Shop for the price by day' })).getByRole('radio', { name: 'Alpha' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Chart range' })).getByRole('radio', { name: '7 days' }));
    const rows = within(await screen.findByRole('table', { name: /Price by day/ })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(7);
    expect(rows[0]!.textContent).toMatch(/22 Oct/);
  });

  it("shows the chosen seller's numbers and the product's attributes", async () => {
    await openProduct();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Shop for the price by day' })).getByRole('radio', { name: 'Alpha' }));
    const numbers = screen.getByRole('region', { name: 'Numbers at Alpha' });
    expect(within(numbers).getByText('Lowest 30 days').nextElementSibling!.textContent).toBe('€709.00');
    const details = screen.getByRole('region', { name: 'Product details' });
    expect(within(details).getByText('Screen').nextElementSibling!.textContent).toBe('15.6"');
    expect(within(details).getByText('Storage').nextElementSibling!.textContent).toBe('512GB');
  });

  it('lets each seller of a product sold by several shops be reported as not the same product', async () => {
    await openProduct();
    const report = within(sellerItem('Alpha')).getByRole('button', { name: 'Not the same product? Report Alpha' });
    expect(report.getAttribute('data-report-target')).toBe('match:1');
  });

  it('turns the chart animation off under prefers-reduced-motion', async () => {
    setMedia(true);
    await openProduct();
    const chart = await screen.findByTestId('sellers-chart');
    await waitFor(() => expect(chart.querySelector('[data-animate]')?.getAttribute('data-animate')).toBe('false'));
  });
});

describe('product page, other states', () => {
  it('puts the product key the API gives in the address (a listing of a matched product)', async () => {
    mockApi(() => json(page()));
    renderAt('/product/s1');
    await screen.findByRole('heading', { level: 1, name: TITLE });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/product/c5'));
  });

  it('shows a not-found state with one h1 for an unknown key, and asks nothing for a malformed one', async () => {
    const fn = mockApi(() => json({ error: 'unknown product' }, 404));
    renderAt('/product/c999');
    expect(await screen.findByRole('heading', { level: 1, name: 'Product not found' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Back to the home page' }).getAttribute('href')).toBe('/');
    cleanup();
    fn.mockClear();
    renderAt('/product/x1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Product not found' })).toBeTruthy();
    expect(fn).not.toHaveBeenCalled();
  });

  it('offers a retry when the API fails, and a malformed answer counts as a failure', async () => {
    const fn = mockApi(() => json({ error: 'internal error' }, 500));
    renderAt('/product/c5');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    cleanup();
    mockApi(() => json({ product: null }));
    renderAt('/product/c5');
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('old listing links /p/:id', () => {
  it('go to their product page, replacing the address', async () => {
    const fn = mockApi(
      () => json(page()),
      (id) => (id === '42' ? json({ product: { id: 42, key: 'c5', title: 'x' } }) : json({ error: 'unknown product' }, 404)),
    );
    renderAt('/p/42');
    await screen.findByRole('heading', { level: 1, name: TITLE });
    expect(screen.getByTestId('where').textContent).toBe('/product/c5');
    expect(fn.mock.calls.map(([u]) => new URL(String(u), 'http://localhost').pathname)).toEqual(['/api/products/42', '/api/product/c5']);
  });

  it('show not found for an unknown or malformed id', async () => {
    const fn = mockApi(() => json(page()));
    renderAt('/p/999');
    expect(await screen.findByRole('heading', { level: 1, name: 'Product not found' })).toBeTruthy();
    cleanup();
    fn.mockClear();
    renderAt('/p/abc');
    expect(await screen.findByRole('heading', { level: 1, name: 'Product not found' })).toBeTruthy();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('product page, Simple, price changes and facts per seller', () => {
  /** Alpha with the same readings but a none verdict: its rise is not in a tag, so the change line says it. */
  const noneAlpha = (extra: Partial<ProductPage> = {}) =>
    page({ sellers: [beta, { ...alpha, cheaper: null, verdict: { ...alpha.verdict, label: 'none', reason: 'Not marked Black Friday and no discount claimed.' } }, gamma], ...extra });
  const goodBeta: SellerView = {
    ...beta,
    verdict: {
      label: 'good',
      reason: '€21.00 below its lowest price in the last 30 days.',
      facts: { low30: 72000, usual: 72500, claimedPct: null, realPct: -2.9, historyDays: 20, priceChanges: 1, wasChanges: 0, daysWorthBuying: 2, judged: true },
    },
  };

  it('says a recent price change on the seller row, marked Black Friday, for a verdict that is not an avoid', async () => {
    await openProduct(noneAlpha());
    expect(within(sellerItem('Alpha')).getByText('Price changed from €709.00 to €799.00 on 22 Oct, while marked Black Friday')).toBeTruthy();
    expect(within(sellerItem('Beta')).queryByText(/Price changed/)).toBeNull();
  });

  it('names a recent change only within the stored raiseWindowDays of the latest day', async () => {
    const later = [...page().history, { ...obs(REP, '2026-10-23', 79900, 88900, true), sellerId: 1 }];
    await openProduct(noneAlpha({ history: later, raiseWindowDays: 2 }));
    expect(within(sellerItem('Alpha')).getByText(/Price changed from €709.00 to €799.00 on 22 Oct/)).toBeTruthy();
    cleanup();
    await openProduct(noneAlpha({ history: later, raiseWindowDays: 1 }));
    expect(within(sellerItem('Alpha')).queryByText(/Price changed/)).toBeNull();
  });

  it('a Black Friday price rise stands out on its seller: alarm banner, raised tag with the real earlier price, and the fact', async () => {
    await openProduct();
    const a = sellerItem('Alpha');
    expect(a.getAttribute('data-alarm')).toBe('true');
    expect(within(a).getByText('Marked Black Friday, price raised')).toBeTruthy();
    expect(within(a).getByRole('img', { name: 'Raised from €709.00 to €799.00' })).toBeTruthy();
    expect(within(a).getByText('Price on 21 Oct: €709.00')).toBeTruthy();
    // the rise is in the tag and the fact: not said a second time
    expect(within(a).queryByText(/Price changed/)).toBeNull();
  });

  it('shows the three numbers of the cheapest seller when its verdict is judged', async () => {
    await openProduct(page({ sellers: [goodBeta, alpha, gamma] }));
    const facts = within(sellerItem('Beta')).getByRole('list', { name: 'Price facts at Beta' });
    expect(within(facts).getByText('Lowest 30 days').nextElementSibling!.textContent).toBe('€720.00');
    expect(within(facts).getByText('Usual price').nextElementSibling!.textContent).toBe('€725.00');
    expect(within(facts).getByText('Real change').nextElementSibling!.textContent).toBe('-2.9%');
  });

  it("shows another judged seller's three numbers when asked, one seller at a time", async () => {
    await openProduct(page({ sellers: [goodBeta, alpha, gamma] }));
    const button = within(sellerItem('Alpha')).getByRole('button', { name: 'Show the price facts at Alpha' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    const facts = within(sellerItem('Alpha')).getByRole('list', { name: 'Price facts at Alpha' });
    expect(within(facts).getByText('Lowest 30 days').nextElementSibling!.textContent).toBe('€709.00');
    expect(within(facts).getByText('Real change').nextElementSibling!.textContent).toBe('+12.7%');
    expect(within(sellerItem('Beta')).queryByRole('list', { name: /Price facts/ })).toBeNull();
    expect(within(sellerItem('Beta')).getByRole('button', { name: 'Show the price facts at Beta' })).toBeTruthy();
  });

  it('shows no three numbers for a none or insufficient verdict (R44)', async () => {
    await openProduct();
    expect(within(sellerItem('Beta')).queryByRole('list', { name: /Price facts/ })).toBeNull();
    expect(within(sellerItem('Beta')).queryByRole('button', { name: /price facts/ })).toBeNull();
    expect(within(sellerItem('Gamma')).queryByRole('button', { name: /price facts/ })).toBeNull();
  });

  it('shows no three numbers for an option the deal check is not about', async () => {
    await openProduct();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Option' })).getByRole('radio', { name: 'Grey' }));
    expect(within(sellerItem('Alpha')).queryByRole('button', { name: /price facts/ })).toBeNull();
    expect(within(sellerItem('Alpha')).queryByRole('list', { name: /Price facts/ })).toBeNull();
  });

  it('says plainly that there is not enough history yet, with the stored minimum', async () => {
    const young: SellerView = { ...gamma, priceCents: 50000, inStock: true, verdict: { label: 'insufficient', reason: 'Not enough price history yet.', facts: { historyDays: 5 } as never } };
    await openProduct(page({ sellers: [beta, alpha, young] }));
    expect(within(sellerItem('Gamma')).getByText(/Not enough price history yet\. We judge a deal after 14 days of prices; we have 5 days so far\./)).toBeTruthy();
  });

  it('lists the colours one shop sells as separate listings as options, each row naming its option', async () => {
    const blue: SellerView = { ...beta, id: 4, productId: 40, shop: 'AtoZ', shopSlug: 'atoz', title: 'JBL Tune 525BT, Blue' };
    const black: SellerView = { ...beta, id: 5, productId: 50, shop: 'AtoZ', shopSlug: 'atoz', title: 'JBL Tune 525BT, Black', priceCents: 70900 };
    await openProduct(
      page({
        sellers: [blue, black],
        cheapestId: 4,
        variants: [
          { id: 40, sellerId: 4, label: 'Blue', priceCents: 69900, inStock: true },
          { id: 50, sellerId: 5, label: 'Black', priceCents: 70900, inStock: true },
        ],
        history: [],
      }),
    );
    expect(within(screen.getByRole('radiogroup', { name: 'Option' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['All', 'Blue', 'Black']);
    const rows = within(screen.getByRole('list', { name: 'Shops selling this product' })).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('[data-option]')?.textContent)).toEqual(['Blue', 'Black']);
    expect(screen.getByText('at AtoZ')).toBeTruthy();
  });
});
