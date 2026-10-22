// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';

afterEach(cleanup);

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
    ['/', 'Home'],
    ['/search', 'Search'],
    ['/deals', 'Deals'],
    ['/shops', 'Shops'],
    ['/shops/digital-zone', 'Shop'],
    ['/p/42', 'Product'],
    ['/how-we-check', 'How we check'],
    ['/admin', 'Admin'],
    ['/admin/reports', 'Admin'],
    ['/nowhere', 'Page not found'],
  ])('%s renders one h1: %s', (path, heading) => {
    renderAt(path);
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]!.textContent).toBe(heading);
  });
});
