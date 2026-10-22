// @vitest-environment jsdom
// Admin pages (web/src/pages/admin/*) against a mocked admin API (fetch stub).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type SiteSettings } from '../../src/site/settings.js';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';
import type { AdminReport, MatchGroup } from '@/lib/admin-api';
import { PROPAGATION_NOTE, PUBLIC_CONFIRM } from '@/pages/admin/Settings';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** routes keyed by "METHOD /path" */
function mockApi(routes: Record<string, Route>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    return route ? route(url, init) : json({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const calls = (fn: ReturnType<typeof mockApi>, method: string, path: string) =>
  fn.mock.calls.filter(([input, init]) => (init?.method ?? 'GET') === method && new URL(String(input), 'http://localhost').pathname === path);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as unknown;

function renderAt(path: string) {
  return render(
    <ModeProvider>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ModeProvider>,
  );
}

function settingsRoutes(settings: SiteSettings = structuredClone(DEFAULT_SETTINGS)) {
  return {
    'GET /api/admin/settings': () => json({ settings }),
    'PUT /api/admin/settings': (_u: URL, init?: RequestInit) => json({ settings: JSON.parse(String(init!.body)) }),
    'GET /api/admin/categories': () => json({ unmapped: [{ path: 'Gadgets > Small Appliances', count: 12 }] }),
  };
}

beforeEach(() => {
  localStorage.clear();
  window.matchMedia = ((query: string) => ({
    matches: /min-width/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('admin settings', () => {
  it('is noindex, has one h1 and the admin section links', async () => {
    mockApi(settingsRoutes());
    renderAt('/admin');
    await screen.findByRole('switch', { name: 'Site is public' });
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, nofollow');
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Admin']);
    const nav = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Settings', 'Phrases', 'Thresholds', 'Reports', 'Shops', 'Matches']);
  });

  it('the public switch asks first, says what changes, and saves only on confirm', async () => {
    const fetch = mockApi(settingsRoutes());
    renderAt('/admin');
    const sw = await screen.findByRole('switch', { name: 'Site is public' });
    expect(screen.getAllByText(PROPAGATION_NOTE).length).toBeGreaterThan(0);
    fireEvent.click(sw);
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: PUBLIC_CONFIRM.on.title })).toBeTruthy();
    expect(within(dialog).getByText(/search engines are allowed to index it/)).toBeTruthy();
    expect(within(dialog).getByText(/within 60 seconds/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(fetch, 'PUT', '/api/admin/settings')).toHaveLength(0);
    expect(sw.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(sw);
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make public' }));
    expect(await screen.findByText('The site is now public.')).toBeTruthy();
    const puts = calls(fetch, 'PUT', '/api/admin/settings');
    expect(puts).toHaveLength(1);
    expect(bodyOf(puts[0]!)).toEqual({ ...DEFAULT_SETTINGS, public: true });
    expect((puts[0]![1] as RequestInit).headers).toMatchObject({ 'content-type': 'application/json' });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Site is public' }).getAttribute('aria-checked')).toBe('true'));
  });

  it('shows the rules read-only, the unmapped shop categories, and saves an override picked from them', async () => {
    const fetch = mockApi(settingsRoutes());
    renderAt('/admin');
    const section = await screen.findByRole('region', { name: 'Categories' });
    expect(within(section).getByRole('table')).toBeTruthy();
    expect(within(section).getAllByText(/next site-build/).length).toBeGreaterThan(0);
    expect(await within(section).findByText('Gadgets > Small Appliances')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Use "small appliances" for a new override' }));
    expect((within(section).getByRole('textbox', { name: 'Shop category part' }) as HTMLInputElement).value).toBe('small appliances');
    fireEvent.change(within(section).getByRole('combobox', { name: 'Category' }), { target: { value: 'appliances' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Add override' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Save overrides' }));
    await within(section).findByText('Saved.');
    expect(bodyOf(calls(fetch, 'PUT', '/api/admin/settings')[0]!)).toMatchObject({ categoryOverrides: { 'small appliances': 'appliances' } });
  });
});

describe('admin phrases and thresholds', () => {
  it('flags an unbalanced * and blocks saving; a fixed line saves the whole document', async () => {
    const fetch = mockApi(settingsRoutes());
    renderAt('/admin/phrases');
    const first = await screen.findByRole('textbox', { name: 'Morning line 1' });
    fireEvent.change(first, { target: { value: 'Broken *line' } });
    expect(screen.getByText('Every * needs a partner, with text between the two.')).toBeTruthy();
    expect(first.getAttribute('aria-invalid')).toBe('true');
    const save = screen.getByRole('button', { name: 'Save phrases' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(first, { target: { value: 'Fixed *line*' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await screen.findByText('Saved.');
    const sent = bodyOf(calls(fetch, 'PUT', '/api/admin/settings')[0]!) as SiteSettings;
    expect(sent.phrases.morning[0]).toBe('Fixed *line*');
    expect(sent.thresholds).toEqual(DEFAULT_SETTINGS.thresholds);
  });

  it('a 400 from the server shows the field it rejected', async () => {
    mockApi({ ...settingsRoutes(), 'PUT /api/admin/settings': () => json({ error: 'invalid', field: 'phrases.late.0' }, 400) });
    renderAt('/admin/phrases');
    fireEvent.click(await screen.findByRole('button', { name: 'Save phrases' }));
    expect(await screen.findByText('Not saved: check phrases.late.0.')).toBeTruthy();
  });

  it('thresholds outside their range block saving', async () => {
    mockApi(settingsRoutes());
    renderAt('/admin/thresholds');
    const raise = await screen.findByRole('spinbutton', { name: 'Rise that counts (%)' });
    fireEvent.change(raise, { target: { value: '-1' } });
    expect(screen.getByText('Use a number from 0.5 to 50.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save thresholds' }) as HTMLButtonElement).disabled).toBe(true);
    const days = screen.getByRole('spinbutton', { name: 'Days of history before judging (days)' });
    fireEvent.change(raise, { target: { value: '3' } });
    fireEvent.change(days, { target: { value: '14.5' } });
    expect(screen.getByText('Use a whole number.')).toBeTruthy();
  });
});

describe('admin reports, shops and matches', () => {
  const report: AdminReport = {
    id: 7,
    targetType: 'product',
    targetId: 11,
    target: { link: '/p/1', label: 'Lenovo IdeaPad' },
    reason: 'wrong-price',
    message: '<b>Shown as</b> <img src=x onerror=alert(1)> 799',
    email: '<i>me</i>@example.com',
    status: 'open',
    adminNote: null,
    createdAt: '2026-10-22T10:00:00.000Z',
    resolvedAt: null,
  };

  it('renders visitor text as text, links the target and sends the chosen status with the note', async () => {
    const fetch = mockApi({
      'GET /api/admin/reports': () => json({ items: [report], total: 1, page: 1, pageSize: 50 }),
      'PATCH /api/admin/reports/7': () => json({ report: { ...report, status: 'fixed' } }),
    });
    renderAt('/admin/reports');
    const item = (await screen.findByText('Lenovo IdeaPad')).closest('li')!;
    expect(within(item).getByRole('link', { name: 'Lenovo IdeaPad' }).getAttribute('href')).toBe('/p/1');
    expect(within(item).getByText(report.message!)).toBeTruthy();
    expect(within(item).getByText(report.email!)).toBeTruthy();
    expect(item.querySelector('b, i, img')).toBeNull();
    fireEvent.change(within(item).getByRole('textbox', { name: 'Admin note (optional)' }), { target: { value: 'Corrected.' } });
    fireEvent.click(within(item).getByRole('button', { name: 'Mark fixed' }));
    await waitFor(() => expect(calls(fetch, 'PATCH', '/api/admin/reports/7')).toHaveLength(1));
    expect(bodyOf(calls(fetch, 'PATCH', '/api/admin/reports/7')[0]!)).toEqual({ status: 'fixed', adminNote: 'Corrected.' });
    // the list reloads
    await waitFor(() => expect(calls(fetch, 'GET', '/api/admin/reports')).toHaveLength(2));
    expect(new URL(String(calls(fetch, 'GET', '/api/admin/reports')[0]![0]), 'http://localhost').search).toBe('?status=open&page=1');
  });

  it('switches a shop hidden', async () => {
    const fetch = mockApi({
      'GET /api/admin/shops': () => json({ shops: [{ slug: 'alpha', name: 'Alpha', active: true, hidden: false, products: 3 }] }),
      'PATCH /api/admin/shops/alpha': () => json({ shop: { slug: 'alpha', hidden: true } }),
    });
    renderAt('/admin/shops');
    const sw = await screen.findByRole('switch', { name: 'Hidden from the site: Alpha' });
    fireEvent.click(sw);
    await screen.findByText('Hidden.');
    expect(bodyOf(calls(fetch, 'PATCH', '/api/admin/shops/alpha')[0]!)).toEqual({ hidden: true });
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('shows each title group with a checkbox per member and confirms one', async () => {
    const group: MatchGroup = {
      canonicalId: 100,
      members: [
        { id: 1, title: 'Lenovo IdeaPad', shop: 'Alpha', shopSlug: 'alpha', priceCents: 70000, confirmed: true },
        { id: 2, title: 'Lenovo IdeaPad laptop', shop: 'Beta', shopSlug: 'beta', priceCents: null, confirmed: false },
      ],
    };
    const fetch = mockApi({
      'GET /api/admin/matches': () => json({ groups: [group], total: 1, page: 1, pageSize: 50 }),
      'PATCH /api/admin/matches/2': () => json({ member: { id: 2, confirmed: true } }),
    });
    renderAt('/admin/matches');
    expect(await screen.findByText(/cheaper-elsewhere claim needs both rows confirmed/)).toBeTruthy();
    const boxes = (await screen.findAllByRole('checkbox', { name: /Lenovo/ })) as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(screen.getByText('No price shown')).toBeTruthy();
    fireEvent.click(boxes[1]!);
    await screen.findByText('Confirmed.');
    expect(bodyOf(calls(fetch, 'PATCH', '/api/admin/matches/2')[0]!)).toEqual({ confirmed: true });
    expect(new URL(String(calls(fetch, 'GET', '/api/admin/matches')[0]![0]), 'http://localhost').search).toBe('?pending=1&page=1');
  });
});
