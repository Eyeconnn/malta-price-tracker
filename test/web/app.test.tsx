// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';

// Pages that load data get an API that is down; their h1 does not depend on it.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"internal error"}', { status: 500 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  return render(
    <ModeProvider>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ModeProvider>,
  );
}

describe('App routes', () => {
  it.each([
    // Home's h1 is the welcome headline; with the API down it is the fallback line
    ['/', 'Is that deal real?'],
    ['/search', 'Search'],
    ['/deals', 'Deals'],
    ['/shops', 'Shops'],
    ['/shops/digital-zone', 'Shop'],
    ['/p/42', 'Product'],
    ['/how-we-check', 'How we check'],
    ['/admin', 'Admin'],
    ['/admin/reports', 'Admin'],
    ['/nowhere', 'Page not found'],
  ])('%s renders one h1: %s', async (path, heading) => {
    renderAt(path);
    const h1 = await screen.findAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]!.textContent).toBe(heading);
  });
});
