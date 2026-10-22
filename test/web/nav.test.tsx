// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ModeProvider, useMode } from '@/components/site/ModeProvider';

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

function Probe() {
  const { mode, theme } = useMode();
  return <output data-testid="probe">{`${mode}/${theme}`}</output>;
}

function renderSite(path = '/') {
  return render(
    <ModeProvider>
      <Probe />
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ModeProvider>,
  );
}

const mobileNav = () => screen.queryByRole('navigation', { name: 'Mobile navigation' });
const mainNav = () => screen.queryByRole('navigation', { name: 'Main navigation' });
const probe = () => screen.getByTestId('probe').textContent;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('layout switches at 768px', () => {
  it('shows the bottom bar and no top nav at 375px', () => {
    setViewport(375);
    renderSite();
    const bar = mobileNav();
    expect(bar).not.toBeNull();
    expect(mainNav()).toBeNull();
    for (const name of ['Search', 'Deals', 'Shops']) {
      expect(within(bar!).getByRole('link', { name })).toBeTruthy();
    }
    expect(within(bar!).getByRole('button', { name: 'More' })).toBeTruthy();
  });

  it('shows the top nav and no bottom bar at 1024px', () => {
    setViewport(1024);
    renderSite();
    const nav = mainNav();
    expect(nav).not.toBeNull();
    expect(mobileNav()).toBeNull();
    for (const name of ['Search', 'Deals', 'Shops', 'How we check']) {
      expect(within(nav!).getByRole('link', { name })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('uses the top nav from exactly 768px and the bottom bar at 767px', () => {
    setViewport(768);
    renderSite();
    expect(mainNav()).not.toBeNull();
    cleanup();
    setViewport(767);
    renderSite();
    expect(mobileNav()).not.toBeNull();
    expect(mainNav()).toBeNull();
  });

  it('hides each bar with CSS classes too', () => {
    setViewport(375);
    renderSite();
    expect(mobileNav()!.className).toContain('md:hidden');
    cleanup();
    setViewport(1024);
    renderSite();
    const header = mainNav()!.closest('header')!;
    expect(header.className).toContain('hidden');
    expect(header.className).toContain('md:block');
  });
});

describe('current page', () => {
  it.each([[375], [1024]])('marks the current route with aria-current at %ipx', (width) => {
    setViewport(width);
    renderSite('/deals');
    const nav = (width < 768 ? mobileNav() : mainNav())!;
    expect(within(nav).getByRole('link', { name: 'Deals' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Search' }).getAttribute('aria-current')).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Shops' }).getAttribute('aria-current')).toBeNull();
  });

  it('keeps Shops current on a shop page', () => {
    setViewport(375);
    renderSite('/shops/digital-zone');
    expect(within(mobileNav()!).getByRole('link', { name: 'Shops' }).getAttribute('aria-current')).toBe('page');
  });

  it('marks How we check as current in the top nav', () => {
    setViewport(1024);
    renderSite('/how-we-check');
    expect(within(mainNav()!).getByRole('link', { name: 'How we check' }).getAttribute('aria-current')).toBe('page');
  });
});

describe('landmarks and headings', () => {
  it.each([[375], [1024]])('the layout renders no h1 and the site name is a link at %ipx', (width) => {
    setViewport(width);
    renderSite('/search');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Black Friday Guide' })).toBeNull();
    const home = screen.getByRole('link', { name: 'Black Friday Guide' });
    expect(home.getAttribute('href')).toBe('/');
    expect(screen.getByRole('main')).toBeTruthy();
  });

  it('offers a skip link to the main content', () => {
    setViewport(375);
    renderSite();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip.getAttribute('href')).toBe('#main');
    expect(screen.getByRole('main').id).toBe('main');
  });

  it('leaves room under the page for the floating bar and respects the safe area', () => {
    setViewport(375);
    renderSite();
    expect(screen.getByRole('main').className).toMatch(/pb-\[calc\([^\]]*safe-area-inset-bottom/);
    expect(mobileNav()!.className).toContain('safe-area-inset-bottom');
  });

  it('gives every nav control a 44px touch target', () => {
    setViewport(375);
    renderSite();
    const bar = mobileNav()!;
    const controls = [...within(bar).getAllByRole('link'), within(bar).getByRole('button', { name: 'More' })];
    expect(controls).toHaveLength(4);
    for (const c of controls) expect(c.className).toContain('min-h-11');
  });
});

describe('More sheet', () => {
  const open = () => {
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    return screen.getByRole('dialog', { name: 'More' });
  };

  it('opens a dialog with How we check, the mode switch and the theme choice', () => {
    setViewport(375);
    renderSite();
    expect(screen.queryByRole('dialog')).toBeNull();
    const dialog = open();
    expect(within(dialog).getByRole('link', { name: 'How we check' })).toBeTruthy();
    expect(within(dialog).getByRole('switch', { name: 'Advanced mode' }).getAttribute('aria-checked')).toBe('false');
    const themes = within(dialog).getByRole('radiogroup', { name: 'Theme' });
    expect(within(themes).getAllByRole('radio').map((r) => r.textContent)).toEqual(['System', 'Light', 'Dark']);
  });

  it('is modal: focus moves inside and the page behind is hidden from assistive tech', async () => {
    setViewport(375);
    renderSite();
    const dialog = open();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(mobileNav()).toBeNull();
  });

  it('closes on Escape and returns focus to the More button', async () => {
    setViewport(375);
    renderSite();
    const more = screen.getByRole('button', { name: 'More' });
    const dialog = open();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(more));
  });

  it('closes from the Close button', async () => {
    setViewport(375);
    renderSite();
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('follows the How we check link and closes', async () => {
    setViewport(375);
    renderSite();
    fireEvent.click(within(open()).getByRole('link', { name: 'How we check' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { level: 1, name: 'How we check' })).toBeTruthy();
  });

  it('toggling Advanced updates the mode', () => {
    setViewport(375);
    renderSite();
    expect(probe()).toBe('simple/system');
    const advanced = within(open()).getByRole('switch', { name: 'Advanced mode' });
    fireEvent.click(advanced);
    expect(probe()).toBe('advanced/system');
    expect(advanced.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(advanced);
    expect(probe()).toBe('simple/system');
  });

  it('choosing a theme updates the theme', () => {
    setViewport(375);
    renderSite();
    fireEvent.click(within(open()).getByRole('radio', { name: 'Dark' }));
    expect(probe()).toBe('simple/dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(probe()).toBe('simple/system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('remembers Advanced mode after a remount', () => {
    setViewport(375);
    renderSite();
    fireEvent.click(within(open()).getByRole('switch', { name: 'Advanced mode' }));
    cleanup();
    renderSite();
    expect(probe()).toBe('advanced/system');
    expect(within(open()).getByRole('switch', { name: 'Advanced mode' }).getAttribute('aria-checked')).toBe('true');
  });

  it('does not crash when localStorage throws', () => {
    setViewport(375);
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error('blocked');
      });
    }
    renderSite();
    expect(probe()).toBe('simple/system');
    fireEvent.click(within(open()).getByRole('switch', { name: 'Advanced mode' }));
    expect(probe()).toBe('advanced/system');
  });
});

describe('top nav controls', () => {
  it('has the same mode switch and theme choice', () => {
    setViewport(1024);
    renderSite();
    const nav = mainNav()!;
    fireEvent.click(within(nav).getByRole('switch', { name: 'Advanced mode' }));
    expect(probe()).toBe('advanced/system');
    fireEvent.click(within(nav).getByRole('radio', { name: 'Light' }));
    expect(probe()).toBe('advanced/light');
  });
});
