// @vitest-environment jsdom
// Search gives one row per product (design Part 3), and a whole result is one link to the product page:
// a tap on its title, price or empty area opens it.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';
import type { ProductResult } from '@/lib/api';

function setViewport(width: number): void {
  window.matchMedia = ((query: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    return { matches: min ? width >= Number(min[1]) : false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false } as MediaQueryList;
  }) as typeof window.matchMedia;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const PHRASES = { morning: ['Is that deal *real*?'], afternoon: ['x'], evening: ['x'], late: ['x'], bfweek: ['x'] };

const result = (key: string, extra: Partial<ProductResult> = {}): ProductResult => ({
  key,
  name: 'Lenovo ThinkBook 16 G6',
  specs: null,
  priceCents: 71900,
  inStock: true,
  shops: 1,
  shop: 'AtoZ',
  logoUrl: null,
  logoAspect: null,
  bf: false,
  imageUrl: null,
  good: 1,
  avoid: 0,
  option: null,
  ...extra,
});
const S25 = (extra: Partial<ProductResult> = {}) =>
  result('c5', { name: 'Samsung Galaxy S25 Ultra Smartphone', specs: '256GB', priceCents: 119900, shops: 3, shop: null, bf: true, good: 0, avoid: 1, ...extra });

let results: ProductResult[] = [];

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

function renderAt(path: string, width = 375) {
  setViewport(width);
  return render(
    <ModeProvider>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <Where />
      </MemoryRouter>
    </ModeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/search') return json({ results });
      if (url.pathname === '/api/home') return json({ phrases: PHRASES, good: [], avoid: [], minHistoryDays: 14 });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const where = () => screen.getByTestId('where').textContent;

describe('Search page results', () => {
  it('a result is one link named by product, shop and price, stretched over the whole card, to its product page', async () => {
    results = [result('s77')];
    renderAt('/search?q=thinkbook');
    const card = await screen.findByRole('article');
    const links = within(card).getAllByRole('link');
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.getAttribute('aria-label')).toBe('Lenovo ThinkBook 16 G6 at AtoZ, €719.00');
    // The link's ::after fills the card (positioned), so a tap on the heading, the price or the empty area lands
    // on the link (jsdom has no hit testing, so check the classes).
    expect(link.className).toContain('after:absolute');
    expect(link.className).toContain('after:inset-0');
    expect(card.className).toContain('relative');
    // the ring and the hover tint are drawn by the link's own ::after (no :has, and the card keeps its glass shadow)
    expect(link.className).toContain('focus-visible:after:ring-[3px]');
    expect(link.className).toContain('focus-visible:after:ring-ring');
    expect(link.className).not.toContain('ring-ring/');
    expect(link.className).toContain('hover:after:bg-secondary');
    expect(card.className).not.toMatch(/ring|has-\[/);
    expect(card.className).toContain('min-h-11');
    fireEvent.click(link);
    expect(where()).toBe('/product/s77');
  });

  it('a product at several shops is one row: name, specs after a middle dot, "from" the lowest price at N shops', async () => {
    results = [S25()];
    renderAt('/search?q=s25');
    const card = await screen.findByRole('article');
    const heading = within(card).getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('Samsung Galaxy S25 Ultra Smartphone · 256GB');
    expect(card.textContent).toContain('from €1,199.00 at 3 shops');
    expect(within(card).getByText('Black Friday')).toBeTruthy();
    expect(card.textContent).toContain('Deal to avoid at 1 shop');
    const link = within(card).getByRole('link');
    expect(link.getAttribute('aria-label')).toBe('Samsung Galaxy S25 Ultra Smartphone, 256GB, from €1,199.00 at 3 shops');
    expect(link.getAttribute('href')).toBe('/product/c5');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    // the verdicts, Black Friday and stock are the link's description
    expect(document.getElementById(link.getAttribute('aria-describedby')!)!.textContent).toBe('Deal to avoid at 1 shop, Black Friday');
  });

  it('names the option of a product sold as one listing after another middle dot', async () => {
    results = [S25({ shops: 1, shop: 'AtoZ', option: 'Grey', avoid: 0, bf: false })];
    renderAt('/search?q=s25');
    const card = await screen.findByRole('article');
    expect(within(card).getByRole('heading', { level: 2 }).textContent).toBe('Samsung Galaxy S25 Ultra Smartphone · 256GB · Grey');
    expect(within(card).getByRole('link').getAttribute('aria-label')).toBe('Samsung Galaxy S25 Ultra Smartphone, 256GB, Grey at AtoZ, €1,199.00');
  });

  it('never shows a zero price, and says when no shop has it in stock', async () => {
    results = [result('s1', { priceCents: null, name: 'No price thing' }), result('s2', { name: 'Gone thing', inStock: false })];
    renderAt('/search?q=thing');
    const cards = await screen.findAllByRole('article');
    expect(cards[0]!.textContent).toContain('Price not shown by the shop');
    expect(cards[0]!.textContent).not.toContain('€0.00');
    expect(cards[1]!.textContent).toContain('Out of stock');
    const gone = within(cards[1]!).getByRole('link');
    expect(document.getElementById(gone.getAttribute('aria-describedby')!)!.textContent).toBe('Real deal, out of stock');
    expect(screen.getByText('2 products')).toBeTruthy();
  });

  it('shows shop text as text, never as HTML', async () => {
    results = [result('s3', { name: '<img src=x onerror=alert(1)> Kettle', shop: '<b>Shop</b>' })];
    renderAt('/search?q=kettle');
    const card = await screen.findByRole('article');
    expect(card.querySelector('img[src="x"]')).toBeNull();
    expect(card.querySelector('b')).toBeNull();
    expect(card.textContent).toContain('<img src=x onerror=alert(1)> Kettle');
  });
});

describe('live result names', () => {
  const open = async () => {
    renderAt('/', 375);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'thinkbook' } });
    return within(await screen.findByRole('region', { name: 'Search results' }, { timeout: 2000 }));
  };

  it('one shop: "<name> at <shop>, <price>", from sr-only text (no aria-label)', async () => {
    results = [result('s77')];
    const region = await open();
    const link = await region.findByRole('link', { name: 'Lenovo ThinkBook 16 G6 at AtoZ, €719.00' });
    expect(link.getAttribute('aria-label')).toBeNull();
    expect(link.querySelector('.sr-only')!.textContent).toBe('Lenovo ThinkBook 16 G6 at AtoZ, €719.00');
    // the visible text carries the same words, so the name contains the visible label
    expect(link.textContent).toContain('Lenovo ThinkBook 16 G6');
    expect(link.textContent).toContain('AtoZ');
    expect(link.textContent).toContain('719.00');
    expect(link.getAttribute('href')).toBe('/product/s77');
  });

  it('several shops: "<name>, <specs>, from <lowest price> at <N> shops"', async () => {
    results = [S25()];
    const region = await open();
    const link = await region.findByRole('link', { name: 'Samsung Galaxy S25 Ultra Smartphone, 256GB, from €1,199.00 at 3 shops' });
    expect(link.textContent).toContain('Samsung Galaxy S25 Ultra Smartphone · 256GB');
    expect(link.textContent).toContain('3 shops');
    expect(within(link).getByText('Black Friday')).toBeTruthy();
  });

  it('keeps the verdicts as the description, not in the name', async () => {
    results = [result('s77')];
    const region = await open();
    const link = await region.findByRole('link', { name: /^Lenovo ThinkBook 16 G6 at AtoZ/ });
    expect(document.getElementById(link.getAttribute('aria-describedby')!)!.textContent).toBe('Real deal');
    cleanup();
    results = [S25()];
    const again = await open();
    const s25 = await again.findByRole('link', { name: /^Samsung Galaxy S25 Ultra/ });
    expect(document.getElementById(s25.getAttribute('aria-describedby')!)!.textContent).toBe('Deal to avoid at 1 shop, Black Friday');
  });
});

describe('live results', () => {
  it('the whole row is one link whose name has the product and shop; clicking title, price or the row opens it', async () => {
    results = [result('c9')];
    for (const target of ['title', 'price', 'row'] as const) {
      renderAt('/', 375);
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'thinkbook' } });
      const region = await screen.findByRole('region', { name: 'Search results' }, { timeout: 2000 });
      const link = await within(region).findByRole('link', { name: /Lenovo ThinkBook 16 G6/ });
      expect(link.getAttribute('aria-label')).toBeNull();
      expect(link.className).toContain('min-h-11');
      expect(link.className).toContain('hover:bg-secondary');
      expect(link.className).toContain('focus-visible:ring-[3px]');
      expect(link.className).toMatch(/focus-visible:ring-ring(\s|$)/);
      const el = target === 'title' ? within(link).getByText('Lenovo ThinkBook 16 G6') : target === 'price' ? link.querySelector<HTMLElement>('.tabular-nums')! : link;
      fireEvent.click(el);
      await waitFor(() => expect(where()).toBe('/product/c9'));
      cleanup();
    }
  });
});
