// @vitest-environment jsdom
// A whole search result is one link: a tap on its title, price or empty area opens the product.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';
import type { GroupItem, GroupResult } from '@/lib/api';

function setViewport(width: number): void {
  window.matchMedia = ((query: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    return { matches: min ? width >= Number(min[1]) : false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false } as MediaQueryList;
  }) as typeof window.matchMedia;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const PHRASES = { morning: ['Is that deal *real*?'], afternoon: ['x'], evening: ['x'], late: ['x'], bfweek: ['x'] };

const item = (id: number, shop: string, slug: string, priceCents: number, title = 'Lenovo ThinkBook 16 G6'): GroupItem => ({
  id,
  title,
  shop,
  shopSlug: slug,
  priceCents,
  wasCents: null,
  verdict: 'good',
  reason: 'r',
  bf: false,
  category: null,
  raisedFrom: null,
  wasRaisedFromCents: null,
  possible: false,
  inStock: true,
  cheaper: null,
});

let results: GroupResult[] = [];

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
  it('a single-shop result is one link named by product, shop and price, stretched over the whole card', async () => {
    results = [{ canonicalId: 1, title: 'Lenovo ThinkBook 16 G6', items: [item(77, 'AtoZ', 'atoz', 71900)] }];
    renderAt('/search?q=thinkbook');
    const card = await screen.findByRole('article');
    const links = within(card).getAllByRole('link');
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.getAttribute('aria-label')).toMatch(/^Lenovo ThinkBook 16 G6 at AtoZ, .*719/);
    // The link's ::after fills the nearest positioned box. With one shop that is the card, so a tap on the
    // heading, the price or the empty area lands on the link (jsdom has no hit testing, so check the classes).
    expect(link.className).toContain('after:absolute');
    expect(link.className).toContain('after:inset-0');
    expect(card.className).toContain('relative');
    expect(link.closest('li')!.className).not.toMatch(/(^|\s)relative(\s|$)/);
    // the ring and the hover tint are drawn by the link's own ::after (no :has, and the card keeps its glass shadow)
    expect(link.className).toContain('focus-visible:after:ring-[3px]');
    expect(link.className).toContain('focus-visible:after:ring-ring');
    expect(link.className).not.toContain('ring-ring/');
    expect(link.className).toContain('hover:after:bg-secondary');
    expect(card.className).not.toMatch(/ring|has-\[/);
    expect(card.className).toContain('min-h-11');
    fireEvent.click(link);
    expect(where()).toBe('/p/77');
  });

  it('each shop row of a multi-shop result is its own whole-row link with the product and shop in its name', async () => {
    results = [
      {
        canonicalId: 1,
        title: 'Lenovo ThinkBook 16 G6',
        items: [item(77, 'AtoZ', 'atoz', 71900), item(78, 'Beta', 'beta', 75900, 'ThinkBook 16 G6 by Lenovo')],
      },
    ];
    renderAt('/search?q=thinkbook');
    const card = await screen.findByRole('article');
    const links = within(card).getAllByRole('link');
    expect(links[0]!.getAttribute('aria-label')).toMatch(/^Lenovo ThinkBook 16 G6 at AtoZ, .*719/);
    expect(links[1]!.getAttribute('aria-label')).toMatch(/^ThinkBook 16 G6 by Lenovo at Beta, .*759/);
    for (const l of links) {
      expect(l.className).toContain('after:absolute');
      expect(l.closest('li')!.className).toContain('relative');
      expect(l.closest('li')!.className).toContain('min-h-11');
      expect(l.className).toContain('focus-visible:after:ring-[3px]');
      expect(l.className).toContain('focus-visible:after:ring-ring');
      expect(l.className).toContain('hover:after:bg-secondary');
      expect(l.closest('li')!.className).not.toContain('has-[');
    }
    fireEvent.click(links[1]!);
    expect(where()).toBe('/p/78');
  });
});

describe('live result names', () => {
  const open = async () => {
    renderAt('/', 375);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'thinkbook' } });
    return within(await screen.findByRole('region', { name: 'Search results' }, { timeout: 2000 }));
  };

  it('one shop: "<title> at <shop>, <price>", from sr-only text (no aria-label)', async () => {
    results = [{ canonicalId: 1, title: 'Lenovo ThinkBook 16 G6', items: [item(77, 'AtoZ', 'atoz', 71900)] }];
    const region = await open();
    const link = await region.findByRole('link', { name: 'Lenovo ThinkBook 16 G6 at AtoZ, \u20ac719.00' });
    expect(link.getAttribute('aria-label')).toBeNull();
    expect(link.querySelector('.sr-only')!.textContent).toBe('Lenovo ThinkBook 16 G6 at AtoZ, \u20ac719.00');
    // the visible text carries the same words, so the name contains the visible label
    expect(link.textContent).toContain('Lenovo ThinkBook 16 G6');
    expect(link.textContent).toContain('AtoZ');
    expect(link.textContent).toContain('719.00');
  });

  it('several shops: "<title>, from <cheapest price> at <N> shops"', async () => {
    results = [{ canonicalId: 1, title: 'Lenovo ThinkBook 16 G6', items: [item(77, 'AtoZ', 'atoz', 71900), item(78, 'Beta', 'beta', 75900)] }];
    const region = await open();
    expect(await region.findByRole('link', { name: 'Lenovo ThinkBook 16 G6, from \u20ac719.00 at 2 shops' })).toBeTruthy();
  });

  it('keeps the verdict as the description, not in the name', async () => {
    results = [{ canonicalId: 1, title: 'Lenovo ThinkBook 16 G6', items: [item(77, 'AtoZ', 'atoz', 71900)] }];
    const region = await open();
    const link = await region.findByRole('link', { name: /^Lenovo ThinkBook 16 G6 at AtoZ/ });
    expect(link.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(link.getAttribute('aria-describedby')!)!.textContent).toBe('Real deal');
  });
});

describe('live results', () => {
  it('the whole row is one link whose name has the product and shop; clicking title, price or the row opens it', async () => {
    results = [{ canonicalId: 1, title: 'Lenovo ThinkBook 16 G6', items: [item(77, 'AtoZ', 'atoz', 71900)] }];
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
      await waitFor(() => expect(where()).toBe('/p/77'));
      cleanup();
    }
  });
});
