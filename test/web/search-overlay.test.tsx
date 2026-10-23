// @vitest-environment jsdom
// The search overlay opened from the navigation (web/src/components/site/SearchOverlay.tsx).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';
import type { GroupResult } from '@/lib/api';

/** matchMedia: (min-width: Npx) answers for the viewport width; prefers-reduced-motion answers `reduced`. */
function setMedia(width: number, reduced = false): void {
  window.matchMedia = ((query: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    return {
      matches: query.includes('prefers-reduced-motion') ? reduced : min ? width >= Number(min[1]) : false,
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PHRASES = { morning: ['Is that deal *real*?'], afternoon: ['Is that deal *real*?'], evening: ['Is that deal *real*?'], late: ['Is that deal *real*?'], bfweek: ['Is that deal *real*?'] };

const groups = (q: string): GroupResult[] => [
  {
    canonicalId: 1,
    title: `${q} result`,
    items: [
      {
        id: 41,
        title: `${q} result`,
        shop: 'Beta',
        shopSlug: 'beta',
        priceCents: 59900,
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
      },
    ],
  },
];

function mockApi() {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/home') return json({ phrases: PHRASES, good: [], avoid: [], minHistoryDays: 14 });
    if (url.pathname === '/api/search') return json({ results: groups(url.searchParams.get('q')!) });
    return json({ error: 'not found' }, 404);
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

const where = () => screen.getByTestId('where').textContent;
const dialog = () => screen.queryByRole('dialog', { name: 'Search products' });
const mainNav = () => screen.getByRole('navigation', { name: 'Main navigation' });
const mobileNav = () => screen.getByRole('navigation', { name: 'Mobile navigation' });
const desktopOpener = () => within(mainNav()).getByRole('button', { name: 'Search' });
const mobileOpener = () => within(mobileNav()).getByRole('button', { name: 'Search' });
const gone = () => waitFor(() => expect(dialog()).toBeNull());

async function openDesktop() {
  const opener = desktopOpener();
  fireEvent.click(opener);
  const d = await screen.findByRole('dialog', { name: 'Search products' });
  return { opener, d };
}

beforeEach(() => {
  localStorage.clear();
  setMedia(1024);
  mockApi();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'scrollY');
});

describe('the Search button in the navigation', () => {
  it('is an icon-only button with the accessible name Search at desktop width, not a link', () => {
    renderAt('/how-we-check');
    const nav = mainNav();
    expect(within(nav).queryByRole('link', { name: 'Search' })).toBeNull();
    const button = desktopOpener();
    expect(button.textContent?.trim()).toBe('');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.className).toContain('min-h-11');
  });

  it('opens the search dialog at desktop width and reports aria-expanded', async () => {
    renderAt('/how-we-check');
    expect(dialog()).toBeNull();
    const { opener, d } = await openDesktop();
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(opener.getAttribute('aria-expanded')).toBe('true');
  });

  it('is a button in the bottom bar at 375px, keeping its label, and opens the same dialog', async () => {
    setMedia(375);
    renderAt('/how-we-check');
    expect(within(mobileNav()).queryByRole('link', { name: 'Search' })).toBeNull();
    const button = mobileOpener();
    expect(button.textContent).toContain('Search');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.className).toContain('min-h-11');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(button);
    const d = await screen.findByRole('dialog', { name: 'Search products' });
    expect(within(d).getByRole('searchbox', { name: 'Search a product' })).toBeTruthy();
  });

  it('opens on the homepage too, while the hero search stays', async () => {
    renderAt('/');
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
    const { d } = await openDesktop();
    expect(within(d).getByRole('searchbox', { name: 'Search a product' })).toBeTruthy();
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await gone();
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
  });
});

describe('the overlay', () => {
  it('has a visible Close search button, an autofocused input and no extra h1', async () => {
    renderAt('/how-we-check');
    const { d } = await openDesktop();
    expect(within(d).getByRole('button', { name: 'Close search' })).toBeTruthy();
    const input = within(d).getByRole('searchbox', { name: 'Search a product' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(within(d).queryAllByRole('heading', { level: 1 })).toHaveLength(0);
    expect(within(d).getByRole('heading', { level: 2, name: 'Search products' })).toBeTruthy();
  });

  it('closes on Escape, returns focus to the opener and does not navigate', async () => {
    renderAt('/how-we-check');
    const { opener } = await openDesktop();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await gone();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(where()).toBe('/how-we-check');
  });

  it('closes from the Close search button and returns focus to the opener', async () => {
    renderAt('/how-we-check');
    const { opener, d } = await openDesktop();
    fireEvent.click(within(d).getByRole('button', { name: 'Close search' }));
    await gone();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(where()).toBe('/how-we-check');
  });

  it('closes when the dimmed backdrop is clicked', async () => {
    renderAt('/how-we-check');
    const { opener } = await openDesktop();
    const backdrop = screen.getByTestId('search-backdrop');
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    await gone();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(where()).toBe('/how-we-check');
  });

  it('closes from the phone bar the same way and returns focus to the bar button', async () => {
    setMedia(375);
    renderAt('/how-we-check');
    const opener = mobileOpener();
    fireEvent.click(opener);
    const d = await screen.findByRole('dialog', { name: 'Search products' });
    fireEvent.click(within(d).getByRole('button', { name: 'Close search' }));
    await gone();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(where()).toBe('/how-we-check');
  });

  it('traps focus: the page behind is hidden from assistive tech while it is open', async () => {
    renderAt('/how-we-check');
    const { d } = await openDesktop();
    await waitFor(() => expect(d.contains(document.activeElement)).toBe(true));
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
    expect(screen.queryByRole('main')).toBeNull();
  });

  it('locks the page scroll while open and releases it on close', async () => {
    renderAt('/how-we-check');
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);
    await openDesktop();
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await gone();
    await waitFor(() => expect(document.body.hasAttribute('data-scroll-locked')).toBe(false));
  });

  it('restores the scroll position when closed, without scrolling when nothing moved', async () => {
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 640 });
    renderAt('/how-we-check');
    await openDesktop();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await gone();
    await waitFor(() => expect(document.activeElement).toBe(desktopOpener()));
    expect(window.scrollY).toBe(640);
    expect(scrollTo).not.toHaveBeenCalled();

    // the page jumped to the top while the overlay was open: closing puts it back
    await openDesktop();
    (window as { scrollY: number }).scrollY = 0;
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await gone();
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 640));
  });

  it('does not restore the old scroll position after navigating to a result', async () => {
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 640 });
    renderAt('/how-we-check');
    const { d } = await openDesktop();
    fireEvent.change(within(d).getByRole('searchbox'), { target: { value: 'ip' } });
    const link = await within(d).findByRole('link', { name: /ip result/ }, { timeout: 2000 });
    (window as { scrollY: number }).scrollY = 0;
    fireEvent.click(link);
    await gone();
    expect(scrollTo).not.toHaveBeenCalledWith(0, 640);
  });
});

describe('searching in the overlay', () => {
  it('shows live results through the API while typing', async () => {
    renderAt('/how-we-check');
    const { d } = await openDesktop();
    fireEvent.change(within(d).getByRole('searchbox'), { target: { value: 'ip' } });
    const results = await within(d).findByRole('region', { name: 'Search results' }, { timeout: 2000 });
    await waitFor(() => expect(within(results).getByRole('link', { name: /ip result/ }).getAttribute('href')).toBe('/p/41'));
    expect(where()).toBe('/how-we-check');
  });

  it('shows the typing example over the empty field when the field is not focused', async () => {
    renderAt('/how-we-check');
    const { d } = await openDesktop();
    const input = within(d).getByRole('searchbox');
    expect(input.getAttribute('placeholder')).toBeNull();
    act(() => input.blur());
    await waitFor(() => expect(within(d).getByTestId('search-example')).toBeTruthy());
  });

  it('Enter goes to /search?q= and closes the overlay', async () => {
    renderAt('/how-we-check');
    const { d } = await openDesktop();
    const input = within(d).getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'iphone 15' } });
    fireEvent.submit(input.closest('form')!);
    await gone();
    expect(where()).toBe('/search?q=iphone+15');
  });

  it('choosing a result navigates normally and closes the overlay', async () => {
    renderAt('/how-we-check');
    const { d } = await openDesktop();
    fireEvent.change(within(d).getByRole('searchbox'), { target: { value: 'ip' } });
    fireEvent.click(await within(d).findByRole('link', { name: /ip result/ }, { timeout: 2000 }));
    await gone();
    expect(where()).toBe('/p/41');
  });

  it('keeps the query when reopened during the same page view, and clears it after navigating', async () => {
    renderAt('/how-we-check');
    let { d } = await openDesktop();
    fireEvent.change(within(d).getByRole('searchbox'), { target: { value: 'ipad' } });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await gone();
    ({ d } = await openDesktop());
    expect((within(d).getByRole('searchbox') as HTMLInputElement).value).toBe('ipad');
    fireEvent.submit(within(d).getByRole('searchbox').closest('form')!);
    await gone();
    expect(where()).toBe('/search?q=ipad');
    ({ d } = await openDesktop());
    expect((within(d).getByRole('searchbox') as HTMLInputElement).value).toBe('');
  });
});

describe('keyboard shortcuts', () => {
  it('/ and Ctrl+K open the overlay when focus is not in a text field', async () => {
    renderAt('/how-we-check');
    fireEvent.keyDown(document.body, { key: '/' });
    await screen.findByRole('dialog', { name: 'Search products' });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await gone();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    await screen.findByRole('dialog', { name: 'Search products' });
  });

  it('do nothing while typing in a field', async () => {
    renderAt('/search');
    const box = screen.getByRole('searchbox');
    box.focus();
    fireEvent.keyDown(box, { key: '/' });
    fireEvent.keyDown(box, { key: 'k', ctrlKey: true });
    expect(dialog()).toBeNull();
  });
});

describe('motion', () => {
  it('animates the backdrop and the panel by default', async () => {
    renderAt('/how-we-check');
    const { d } = await openDesktop();
    expect(d.className).toContain('search-overlay-animated');
    expect(screen.getByTestId('search-backdrop').className).toContain('search-overlay-animated');
  });

  it('renders without animation classes under prefers-reduced-motion', async () => {
    setMedia(1024, true);
    renderAt('/how-we-check');
    const { d } = await openDesktop();
    expect(d.className).not.toContain('animat');
    expect(screen.getByTestId('search-backdrop').className).not.toContain('animat');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await gone();
  });
});
