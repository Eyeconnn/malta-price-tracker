// @vitest-environment jsdom
// Product page (web/src/pages/Product.tsx) against a mocked read API, with the Lenovo case:
// €709.00 until 21 Oct, €799.00 on 22 Oct while marked Black Friday (+€90.00, +12.7%).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';
import type { HistoryObs, OtherShop, ProductResponse } from '@/lib/api';
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

/** The 16GB variant (the verdict's): 23 Sep to 21 Oct at €709.00 (was €739.00, marked from 21 Oct), €799.00 on 22 Oct. */
const lenovoHistory: HistoryObs[] = [
  ...daysFrom('2026-09-23', 29).map((d) => obs(REP, d, 70900, 73900, d === '2026-10-21')),
  obs(REP, '2026-10-22', 79900, 88900, true),
];
/** The 8GB variant: €599.00 every day from 13 Oct, no was price. */
const smallHistory = daysFrom('2026-10-13', 10).map((d) => obs(SMALL, d, 59900, null, false));
const history = [...lenovoHistory, ...smallHistory].sort((a, b) => a.at.localeCompare(b.at) || a.productId - b.productId);

function other(id: number, shop: string, priceCents: number | null, possible: boolean, extra: Partial<OtherShop> = {}): OtherShop {
  return {
    id,
    title: `Lenovo V15 G5 at ${shop}`,
    shop,
    shopSlug: shop.toLowerCase(),
    priceCents,
    inStock: true,
    verdict: 'none',
    matchMethod: possible ? 'title' : 'gtin',
    possible,
    ...extra,
  };
}

const scan = other(9, 'Scan', 69900, false);

function lenovo(extra: Partial<ProductResponse> = {}): ProductResponse {
  return {
    product: {
      id: 7,
      productId: REP,
      title: 'Lenovo V15 G5 15.6" i5, 16GB, 512GB',
      brand: 'Lenovo',
      url: 'https://atoz.example/p/7',
      imageUrl: null,
      category: 'laptops',
      shopId: 1,
      shop: 'AtoZ Electronics',
      shopSlug: 'atoz',
      priceCents: 79900,
      wasCents: 88900,
      inStock: true,
      bf: true,
      variantCount: 2,
      canonicalId: 3,
      matchMethod: 'gtin',
      matchConfirmed: false,
    },
    variants: [
      { id: REP, title: 'Lenovo V15 G5', variantTitle: '16GB', priceCents: 79900, inStock: true },
      { id: SMALL, title: 'Lenovo V15 G5', variantTitle: '8GB', priceCents: 59900, inStock: true },
    ],
    history,
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
      },
    },
    others: [scan, other(10, 'Intercomp', 74500, true)],
    cheaper: scan,
    minHistoryDays: 14,
    raiseWindowDays: 14,
    ...extra,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockProduct(answer: (id: string) => Response) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const m = /^\/api\/products\/(.*)$/.exec(url.pathname);
    return m ? answer(m[1]!) : json({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderAt(path: string) {
  return render(
    <ModeProvider>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ModeProvider>,
  );
}

async function openLenovo(data: ProductResponse = lenovo()) {
  mockProduct(() => json(data));
  const view = renderAt('/p/7');
  await screen.findByRole('heading', { level: 1, name: data.product.title });
  return view;
}

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
});
afterEach(() => {
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
  it('shows the title as the one h1, the raised tag with €709.00 crossed out and the reason sentence', async () => {
    await openLenovo();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const tag = screen.getByRole('img', { name: 'Raised from €709.00 to €799.00' });
    expect(tag.querySelector('s')?.textContent).toBe('€709.00');
    expect(screen.getByText('Price went from €709.00 on 21 Oct to €799.00 on 22 Oct while marked Black Friday.')).toBeTruthy();
  });

  it('makes a Black Friday price rise stand out: the alarm banner and the earlier price', async () => {
    await openLenovo();
    expect(screen.getByText('Marked Black Friday, price raised')).toBeTruthy();
    expect(screen.getByText('Price on 21 Oct: €709.00')).toBeTruthy();
  });

  it('shows the three numbers: lowest 30 days, usual price and real change', async () => {
    await openLenovo();
    const numbers = screen.getByRole('list', { name: 'Price facts' });
    expect(within(numbers).getByText('Lowest 30 days').nextElementSibling?.textContent).toBe('€709.00');
    expect(within(numbers).getByText('Usual price').nextElementSibling?.textContent).toBe('€709.00');
    expect(within(numbers).getByText('Real change').nextElementSibling?.textContent).toBe('+12.7%');
  });

  it('shows the CheaperBox linking to the cheaper shop when cheaper is set', async () => {
    await openLenovo();
    const link = screen.getByRole('link', { name: /Cheaper at Scan, €699\.00/ });
    expect(link.getAttribute('href')).toBe('/p/9');
    expect(link.textContent).toMatch(/€100\.00 less/);
  });

  it('has no CheaperBox when cheaper is null', async () => {
    await openLenovo(lenovo({ cheaper: null }));
    expect(screen.queryByText(/Cheaper at/)).toBeNull();
  });

  it('never shows a CheaperBox for a title-only match, even if the API sent one', async () => {
    await openLenovo(lenovo({ cheaper: other(10, 'Intercomp', 50000, true) }));
    expect(screen.queryByText(/Cheaper at/)).toBeNull();
  });

  it('lists only exactly matched other shops, never a title-only match', async () => {
    await openLenovo();
    const list = screen.getByRole('region', { name: 'Other shops' });
    expect(within(list).getByRole('link', { name: /Scan/ }).getAttribute('href')).toBe('/p/9');
    expect(within(list).queryByText(/Intercomp/)).toBeNull();
    expect(screen.queryByText(/possibly the same product/i)).toBeNull();
  });

  it('shows no chart, day table, variants or numbers panel', async () => {
    await openLenovo();
    expect(screen.queryByRole('table', { name: /Price by day/ })).toBeNull();
    expect(screen.queryByTestId('price-chart')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Chart range' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Variant' })).toBeNull();
  });

  it('has a "Something wrong?" button that opens the report form for this product', async () => {
    await openLenovo();
    const button = screen.getByRole('button', { name: 'Something wrong?' });
    // the report target (Ruling R20): the verdict's variant, products.id
    expect(button.getAttribute('data-report-target')).toBe(`product:${REP}`);
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Something wrong?' })).toBeTruthy();
    expect(within(dialog).getByRole('radiogroup', { name: 'What is wrong?' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Send report' })).toBeTruthy();
  });

  it('has no report button when the product has no variant to report (productId null)', async () => {
    const data = lenovo();
    data.product = { ...data.product, productId: null };
    await openLenovo(data);
    expect(screen.queryByRole('button', { name: 'Something wrong?' })).toBeNull();
  });

  it('says a recent price change for a product that is not an avoid', async () => {
    const data = lenovo({ cheaper: null });
    data.verdict = { ...data.verdict, label: 'none', reason: 'Not marked Black Friday and no discount claimed.' };
    await openLenovo(data);
    expect(screen.getByText('Price changed from €709.00 to €799.00 on 22 Oct, while marked Black Friday')).toBeTruthy();
  });

  it('names a recent change only within the stored raiseWindowDays of the latest day', async () => {
    const later = [...history, obs(REP, '2026-10-23', 79900, 88900, true)];
    const none = (raiseWindowDays: number) => {
      const data = lenovo({ cheaper: null, history: later, raiseWindowDays });
      data.verdict = { ...data.verdict, label: 'none', reason: 'Not marked Black Friday and no discount claimed.' };
      return data;
    };
    await openLenovo(none(2));
    expect(screen.getByText(/Price changed from €709.00 to €799.00 on 22 Oct/)).toBeTruthy();
    cleanup();
    await openLenovo(none(1));
    expect(screen.queryByText(/Price changed/)).toBeNull();
  });

  it('says plainly that there is not enough history yet, with the stored minimum', async () => {
    const data = lenovo({ cheaper: null, minHistoryDays: 21, history: lenovoHistory.slice(-5) });
    data.verdict = { label: 'insufficient', reason: 'Not enough history yet: 5 days tracked, 21 needed.', facts: { ...data.verdict.facts!, historyDays: 5 } };
    await openLenovo(data);
    expect(screen.getByText('Not enough price history yet')).toBeTruthy();
    expect(screen.getByText(/We judge a deal after 21 days of prices\. We have 5 days for this product so far\./)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Price facts' })).toBeNull();
    expect(screen.queryByRole('img', { name: /Raised/ })).toBeNull();
  });

  it('shows "Price not shown by the shop" for a product without a price, never €0.00', async () => {
    const data = lenovo({ cheaper: null });
    data.product = { ...data.product, priceCents: null, wasCents: null };
    data.verdict = { label: 'insufficient', reason: 'Price not shown by the shop.', facts: null };
    const { container } = await openLenovo(data);
    expect(screen.getAllByText(/Price not shown by the shop/).length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/€0\.00/);
  });

  it('renders shop text as text', async () => {
    const data = lenovo({ cheaper: null });
    data.product = { ...data.product, title: '<img src=x onerror=alert(1)> Laptop', shop: '<b>Evil</b>' };
    const { container } = await openLenovo(data);
    expect(screen.getAllByText(/<b>Evil<\/b>/).length).toBeGreaterThan(0);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});

describe('product page, Advanced', () => {
  // the first import of Recharts is slow in the test runner; load it once up front
  beforeAll(async () => {
    await import('@/components/site/PriceChart');
  }, 30_000);
  beforeEach(() => localStorage.setItem('mode', 'advanced'));

  async function dayTable() {
    return screen.findByRole('table', { name: /Price by day/ });
  }

  it('DayTable row for 22 Oct shows +€90.00 and +12.7%, marked Black Friday, not worth buying', async () => {
    await openLenovo();
    const row = within(await dayTable()).getByRole('row', { name: /22 Oct/ });
    expect(within(row).getByText('+€90.00')).toBeTruthy();
    expect(within(row).getByText('+12.7%')).toBeTruthy();
    expect(within(row).getByText('€799.00')).toBeTruthy();
    expect(within(row).getByText('€889.00')).toBeTruthy();
    expect(within(row).getByText('Marked')).toBeTruthy();
    expect(within(row).getByText('No')).toBeTruthy();
    const before = within(await dayTable()).getByRole('row', { name: /21 Oct/ });
    expect(within(before).getByText('No change')).toBeTruthy();
    expect(within(before).getByText('Yes')).toBeTruthy();
  });

  it('switching to 7 days keeps only the last 7 days in the chart data and the table', async () => {
    await openLenovo();
    const chart = await screen.findByTestId('price-chart');
    expect(chart.getAttribute('data-points')).toBe('30');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Chart range' })).getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(screen.getByTestId('price-chart').getAttribute('data-points')).toBe('7'));
    const rows = within(await dayTable()).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(7);
    expect(rows[0]!.textContent).toMatch(/22 Oct/);
    expect(rows[6]!.textContent).toMatch(/16 Oct/);
  });

  it('describes the chart by the day table (its text alternative)', async () => {
    await openLenovo();
    const chart = await screen.findByTestId('price-chart');
    const table = await dayTable();
    expect(chart.getAttribute('aria-describedby')).toBe(table.id);
    expect(chart.getAttribute('role')).toBe('img');
  });

  it('loads the Recharts chart and turns its animation off under prefers-reduced-motion', async () => {
    setMedia(true);
    await openLenovo();
    const chart = await screen.findByTestId('price-chart');
    await waitFor(() => expect(chart.querySelector('[data-animate]')?.getAttribute('data-animate')).toBe('false'));
  });

  it('shows the numbers panel from the stored facts', async () => {
    await openLenovo();
    const panel = screen.getByRole('region', { name: 'Numbers' });
    const value = (label: string) => within(panel).getByText(label).nextElementSibling?.textContent;
    expect(value('Lowest 30 days')).toBe('€709.00');
    expect(value('Claimed discount')).toBe('-10.1%');
    expect(value('Real change vs lowest 30 days')).toBe('+12.7%');
    expect(value('Price before the rise')).toBe('€709.00 on 21 Oct');
    expect(value('Was price before its rise')).toBe('€739.00');
    expect(value('Days worth buying')).toBe('29 of 30');
  });

  it('lists title-only matches labelled "possibly the same product" in the comparison table', async () => {
    await openLenovo();
    const table = screen.getByRole('table', { name: 'Other shops' });
    const intercomp = within(table).getByRole('row', { name: /Intercomp/ });
    expect(within(intercomp).getByText('possibly the same product')).toBeTruthy();
    const scanRow = within(table).getByRole('row', { name: /Scan/ });
    expect(within(scanRow).queryByText('possibly the same product')).toBeNull();
  });

  it('lets each comparison row be reported as a wrong match (target: that row, site_products.id)', async () => {
    await openLenovo();
    const table = screen.getByRole('table', { name: 'Other shops' });
    const button = within(table).getByRole('button', { name: 'Report a wrong match with Intercomp' });
    expect(button.textContent).toBe('Report');
    expect(button.getAttribute('data-report-target')).toBe('match:10');
    expect(within(table).getByRole('button', { name: 'Report a wrong match with Scan' }).getAttribute('data-report-target')).toBe('match:9');
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Wrong match?' })).toBeTruthy();
    expect((within(dialog).getAllByRole('radio')[0] as HTMLInputElement).value).toBe('wrong-match');
  });

  it('shows the verdict variant by default and never mixes variants; another variant can be picked', async () => {
    await openLenovo();
    const picker = screen.getByRole('radiogroup', { name: 'Variant' });
    expect(within(picker).getByRole('radio', { name: /16GB/ }).getAttribute('aria-checked')).toBe('true');
    expect(within(await dayTable()).queryByText('€599.00')).toBeNull();
    fireEvent.click(within(picker).getByRole('radio', { name: /8GB/ }));
    const table = await dayTable();
    await waitFor(() => expect(within(table).getAllByText('€599.00')).toHaveLength(10));
    expect(within(table).queryByText('€709.00')).toBeNull();
    expect(within(table).queryByText('Yes')).toBeNull();
    expect(screen.getByTestId('price-chart').getAttribute('data-points')).toBe('10');
  });

  it('shows a missing price as "Price not shown by the shop", with no % on it or the next day', async () => {
    const data = lenovo();
    data.history = data.history.map((h) => (h.productId === REP && h.at.startsWith('2026-10-21') ? { ...h, price: null } : h));
    const { container } = await openLenovo(data);
    const table = await dayTable();
    const hidden = within(table).getByRole('row', { name: /21 Oct/ });
    expect(within(hidden).getByText('Price not shown by the shop')).toBeTruthy();
    expect(hidden.textContent).not.toMatch(/%/);
    const next = within(table).getByRole('row', { name: /22 Oct/ });
    expect(next.textContent).not.toMatch(/%/);
    expect(within(next).getByText('Previous day not shown by the shop')).toBeTruthy();
    // only the first tracked day has no earlier price
    expect(within(table).getAllByText('No earlier price')).toHaveLength(1);
    expect(within(within(table).getByRole('row', { name: /23 Sep/ })).getByText('No earlier price')).toBeTruthy();
    expect(container.textContent).not.toMatch(/€0\.00/);
  });
});

describe('product page, Advanced, unjudged verdicts (Ruling R44)', () => {
  beforeAll(async () => {
    await import('@/components/site/PriceChart');
  }, 30_000);
  beforeEach(() => localStorage.setItem('mode', 'advanced'));

  it.each(['insufficient', 'none'] as const)('verdict %s: shows no worth-buying answers, bands or count', async (label) => {
    const data = lenovo({ cheaper: null });
    data.verdict = { ...data.verdict, label, reason: 'Not enough history yet: 30 days tracked, 40 needed.' };
    await openLenovo(data);
    const table = await screen.findByRole('table', { name: /Price by day/ });
    expect(within(table).queryByText('Yes')).toBeNull();
    expect(within(table).queryByText('No')).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: 'Worth buying' })).toBeNull();
    const chart = await screen.findByTestId('price-chart');
    await waitFor(() => expect(chart.querySelector('[data-animate]')).not.toBeNull());
    expect(chart.querySelector('[data-bands]')?.getAttribute('data-bands')).toBe('0');
    expect(screen.queryByText('Worth buying')).toBeNull();
    const panel = screen.getByRole('region', { name: 'Numbers' });
    expect(within(panel).queryByText('Days worth buying')).toBeNull();
  });

  it('a judged verdict shows its bands', async () => {
    await openLenovo();
    const chart = await screen.findByTestId('price-chart');
    await waitFor(() => expect(chart.querySelector('[data-bands]')?.getAttribute('data-bands')).toBe('2'));
  });
});

describe('product page, other states', () => {
  it('shows a not-found state with one h1 and a link home for an unknown id', async () => {
    mockProduct(() => json({ error: 'unknown product' }, 404));
    renderAt('/p/999');
    expect(await screen.findByRole('heading', { level: 1, name: 'Product not found' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Back to the home page' }).getAttribute('href')).toBe('/');
    expect(screen.queryByRole('button', { name: 'Something wrong?' })).toBeNull();
  });

  it('shows not found for a non-numeric id without asking the API', async () => {
    const fn = mockProduct(() => json(lenovo()));
    renderAt('/p/abc');
    expect(await screen.findByRole('heading', { level: 1, name: 'Product not found' })).toBeTruthy();
    expect(fn).not.toHaveBeenCalled();
  });

  it('offers a retry when the API fails, and a malformed answer counts as a failure', async () => {
    const fn = mockProduct(() => json({ error: 'internal error' }, 500));
    renderAt('/p/7');
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    cleanup();
    mockProduct(() => json({ product: null }));
    renderAt('/p/7');
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
