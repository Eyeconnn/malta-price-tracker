// @vitest-environment jsdom
// useMediaQuery (web/src/lib/useMediaQuery.ts) with a matchMedia stub that records its listeners.
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';
import { DESKTOP_QUERY } from '@/components/site/nav';

type Listener = (e: { matches: boolean }) => void;

/** One MediaQueryList per query, shared between matchMedia calls; `resize` fires `change` on the ones that flip. */
function stubMatchMedia(width: number) {
  let current = width;
  const lists = new Map<string, { mql: MediaQueryList; listeners: Set<Listener>; added: Listener[]; removed: Listener[] }>();
  const matches = (query: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    return min ? current >= Number(min[1]) : false;
  };
  window.matchMedia = ((query: string) => {
    let entry = lists.get(query);
    if (!entry) {
      const listeners = new Set<Listener>();
      const added: Listener[] = [];
      const removed: Listener[] = [];
      const mql = {
        get matches() {
          return matches(query);
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, fn: Listener) => {
          added.push(fn);
          listeners.add(fn);
        },
        removeEventListener: (_type: string, fn: Listener) => {
          removed.push(fn);
          listeners.delete(fn);
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
      entry = { mql, listeners, added, removed };
      lists.set(query, entry);
    }
    return entry.mql;
  }) as typeof window.matchMedia;
  return {
    resize(next: number) {
      const before = new Map([...lists].map(([q]) => [q, matches(q)]));
      current = next;
      for (const [q, e] of lists) if (before.get(q) !== matches(q)) for (const fn of [...e.listeners]) fn({ matches: matches(q) });
    },
    entry: (query: string) => lists.get(query),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useMediaQuery', () => {
  it('swaps the top nav and the bottom bar on change, and removes the same listener on unmount', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"down"}', { status: 503 })));
    const media = stubMatchMedia(1024);
    const view = render(
      <ModeProvider>
        <MemoryRouter initialEntries={['/how-we-check']}>
          <App />
        </MemoryRouter>
      </ModeProvider>,
    );
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Mobile navigation' })).toBeNull();

    act(() => media.resize(375));
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Mobile navigation' })).not.toBeNull();

    act(() => media.resize(1280));
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Mobile navigation' })).toBeNull();

    const desktop = media.entry(DESKTOP_QUERY)!;
    expect(desktop.added.length).toBeGreaterThan(0);
    view.unmount();
    expect(desktop.listeners.size).toBe(0);
    expect(desktop.removed).toEqual(expect.arrayContaining(desktop.added));
  });

  it('the sticky top bar uses the opaque bar fill, not see-through glass', () => {
    stubMatchMedia(1024);
    render(
      <ModeProvider>
        <MemoryRouter initialEntries={['/how-we-check']}>
          <App />
        </MemoryRouter>
      </ModeProvider>,
    );
    const header = screen.getByRole('navigation', { name: 'Main navigation' }).closest('header')!;
    expect(header.className).toContain('bg-bar');
    expect(header.className).not.toContain('bg-glass');
  });
});
