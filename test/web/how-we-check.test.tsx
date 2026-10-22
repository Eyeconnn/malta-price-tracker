// @vitest-environment jsdom
// How we check page: plain-words explanation with the live thresholds from GET /api/thresholds.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderPage() {
  return render(
    <ModeProvider>
      <MemoryRouter initialEntries={['/how-we-check']}>
        <App />
      </MemoryRouter>
    </ModeProvider>,
  );
}

const bodyText = () => document.body.textContent ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  localStorage.clear();
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('how we check', () => {
  it('has one h1 and short sections for each topic', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ thresholds: DEFAULT_SETTINGS.thresholds })));
    renderPage();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('How we check');
    const h2 = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(h2).toEqual([
      'What we record',
      'The EU 30-day lowest price rule',
      'Good Deal and Deal to Avoid',
      'Shop ratings',
      'The same product at other shops',
      'Found a mistake?',
    ]);
  });

  it('states what is recorded and since when, and names the rule', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ thresholds: DEFAULT_SETTINGS.thresholds })));
    renderPage();
    const t = bodyText();
    expect(t).toContain('20 October 2026');
    expect(t).toContain('about 50 Maltese web shops');
    expect(t).toContain('Article 6a');
    expect(t).toContain('Omnibus Directive');
    expect(t).toContain('not legal advice');
    expect(t).toContain('Something wrong?');
    expect(t).toContain('possibly the same product');
  });

  it('shows the default thresholds while loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    renderPage();
    const t = bodyText();
    expect(t).toContain('more than 3%');
    expect(t).toContain('at least 5%');
    expect(t).toContain('14 days');
    expect(t).toContain('30 days');
    expect(t).toContain('at least 20 judged products');
    expect(t).toContain('at least 2%');
  });

  it('shows the default thresholds when the call fails', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'internal error' }, 500));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await sleep(20);
    expect(bodyText()).toContain('more than 3%');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows the thresholds from the API', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      json({
        thresholds: { minHistoryDays: 21, baselineDays: 45, raiseWindowDays: 10, raisePct: 4, goodDropPct: 7.5, cheaperPct: 3, minJudgedForRating: 35 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    await waitFor(() => expect(bodyText()).toContain('more than 4%'));
    const t = bodyText();
    expect(new URL(String(fetchMock.mock.calls[0]![0]), 'http://localhost').pathname).toBe('/api/thresholds');
    expect(t).toContain('at least 7.5%');
    expect(t).toContain('21 days');
    expect(t).toContain('45 days');
    expect(t).toContain('10 days');
    expect(t).toContain('at least 35 judged products');
    expect(t).toContain('at least 3%');
    expect(t).not.toContain('more than 3%');
  });

  it('falls back to the defaults when the answer has the wrong shape', async () => {
    const fetchMock = vi.fn(async () => json({ thresholds: { raisePct: 'x' } }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await sleep(20);
    expect(bodyText()).toContain('more than 3%');
  });

  it('uses no em dash and no loaded words', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ thresholds: DEFAULT_SETTINGS.thresholds })));
    renderPage();
    const t = bodyText();
    expect(t).not.toContain(String.fromCharCode(0x2014));
    expect(t.toLowerCase()).not.toContain('scam');
  });
});
