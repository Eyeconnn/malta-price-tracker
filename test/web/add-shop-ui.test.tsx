// @vitest-environment jsdom
// Admin "Add shop" page (web/src/pages/admin/AddShop.tsx) against a mocked admin API (fetch stub).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';
import { App } from '@/App';
import { ModeProvider } from '@/components/site/ModeProvider';
import type { AdminShopRequest } from '@/lib/admin-api';
import { REFRESH_MS } from '@/pages/admin/AddShop';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function mockApi(routes: Record<string, Route>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/admin/settings') return json({ settings: DEFAULT_SETTINGS });
    const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    return route ? route(url, init) : json({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const calls = (fn: ReturnType<typeof mockApi>, method: string, path: string) =>
  fn.mock.calls.filter(([input, init]) => (init?.method ?? 'GET') === method && new URL(String(input), 'http://localhost').pathname === path);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as unknown;

const renderAt = (path: string) =>
  render(
    <ModeProvider>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ModeProvider>,
  );

const base: AdminShopRequest = {
  id: 1,
  origin: 'https://shop.example.mt',
  name: null,
  category: null,
  status: 'pending',
  requestedAt: '2026-10-23T08:00:00.000Z',
  startedAt: null,
  checkedAt: null,
  platform: null,
  robots: null,
  productsFound: null,
  sample: [],
  details: null,
  error: null,
  attempts: 0,
  shop: null,
};
const active: AdminShopRequest = {
  ...base,
  id: 2,
  origin: 'https://toys.example.mt',
  status: 'active',
  platform: 'shopify',
  checkedAt: '2026-10-23T08:15:00.000Z',
  robots: { status: 'ok', allowed: true, crawlDelaySeconds: 5, blockedBy: null },
  productsFound: 50,
  sample: [{ title: '<img src=x onerror=alert(1)> Robot', priceCents: 3999, url: 'https://toys.example.mt/products/robot' }],
  attempts: 1,
  shop: { slug: 'toys-example', active: true },
};
const failed: AdminShopRequest = { ...base, id: 3, origin: 'https://thin.example.mt', status: 'failed', platform: 'woocommerce', error: 'Only 4 products with a title and a price above zero (at least 10 needed).', attempts: 1, productsFound: 4 };
const blocked: AdminShopRequest = {
  ...base,
  id: 4,
  origin: 'https://closed.example.mt',
  status: 'blocked',
  platform: 'shopify',
  robots: { status: 'ok', allowed: false, crawlDelaySeconds: 0, blockedBy: { path: '/products.json', rule: 'Disallow: /products.json (line 3)' } },
  error: 'robots.txt blocks the Shopify product feed: Disallow: /products.json (line 3)',
};
const setup: AdminShopRequest = {
  ...base,
  id: 5,
  origin: 'https://fashion.example.mt',
  status: 'needs_setup',
  platform: 'unknown',
  error: 'The platform is not Shopify, WooCommerce or Magento, so this shop needs a custom setup in a later session.',
  details: { server: 'nginx', poweredBy: null, generator: ['PrestaShop'], jsonLdProduct: true, productPagesChecked: ['/en/1-shirt.html'], categoryLinks: ['/en/3-clothes'], disallowed: [] },
};

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('admin Add shop page', () => {
  it('has an Add shop nav entry, one h1 and a labelled form', async () => {
    mockApi({ 'GET /api/admin/shop-requests': () => json({ requests: [], maxQueued: 20 }) });
    renderAt('/admin/add-shop');
    expect(await screen.findByRole('textbox', { name: 'Shop web address' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Display name (optional)' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Shop category (optional)' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Admin']);
    const nav = screen.getByRole('navigation', { name: 'Admin sections' });
    const link = within(nav).getByRole('link', { name: 'Add shop' });
    expect(link.getAttribute('href')).toBe('/admin/add-shop');
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(await screen.findByText('No shops requested yet.')).toBeTruthy();
  });

  it('shows an inline error for a bad address and sends nothing', async () => {
    const fetch = mockApi({ 'GET /api/admin/shop-requests': () => json({ requests: [], maxQueued: 20 }) });
    renderAt('/admin/add-shop');
    const input = await screen.findByRole('textbox', { name: 'Shop web address' });
    fireEvent.change(input, { target: { value: 'http://192.168.1.10/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add shop' }));
    expect(await screen.findByText("Use the shop's name, not an IP address.")).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe("Use the shop's name, not an IP address.");
    expect(document.activeElement).toBe(input);
    expect(calls(fetch, 'POST', '/api/admin/shop-requests')).toHaveLength(0);
  });

  it('adds a shop: sends address, name and category, confirms and lists it', async () => {
    let list: AdminShopRequest[] = [];
    const fetch = mockApi({
      'GET /api/admin/shop-requests': () => json({ requests: list, maxQueued: 20 }),
      'POST /api/admin/shop-requests': (_u, init) => {
        const b = JSON.parse(String(init!.body)) as { url: string; name: string | null; category: string | null };
        const created = { ...base, id: 9, origin: 'https://new.example.mt', name: b.name, category: b.category };
        list = [created];
        return json({ request: created }, 201);
      },
    });
    renderAt('/admin/add-shop');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Shop web address' }), { target: { value: 'new.example.mt' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name (optional)' }), { target: { value: 'New Shop' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Shop category (optional)' }), { target: { value: 'toys' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add shop' }));
    expect(await screen.findByText(/Added https:\/\/new\.example\.mt\. The PC checks new shops every 15 minutes\./)).toBeTruthy();
    expect(bodyOf(calls(fetch, 'POST', '/api/admin/shop-requests')[0]!)).toEqual({ url: 'new.example.mt', name: 'New Shop', category: 'toys' });
    const item = (await screen.findByText('New Shop')).closest('li')!;
    expect(within(item).getByText('Waiting')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Shop web address' }) as HTMLInputElement).value).toBe('');
  });

  it('shows the server refusal next to the field: already a shop, already requested, queue full', async () => {
    const answers = [
      json({ error: 'duplicate', field: 'url', reason: 'shop', slug: 'klikk' }, 409),
      json({ error: 'duplicate', field: 'url', reason: 'request', status: 'failed' }, 409),
      json({ error: 'too many pending', max: 20 }, 429),
    ];
    mockApi({ 'GET /api/admin/shop-requests': () => json({ requests: [], maxQueued: 20 }), 'POST /api/admin/shop-requests': () => answers.shift()! });
    renderAt('/admin/add-shop');
    const input = await screen.findByRole('textbox', { name: 'Shop web address' });
    const submit = screen.getByRole('button', { name: 'Add shop' });
    fireEvent.change(input, { target: { value: 'https://klikk.com.mt' } });
    fireEvent.click(submit);
    expect(await screen.findByText('This shop is already in the shop list (klikk).')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(submit);
    expect(await screen.findByText('This address was already requested (now: Failed). Use Retry or Reject in the list below.')).toBeTruthy();
    fireEvent.click(submit);
    expect(await screen.findByText('20 shops are already waiting to be checked. Try again after the next check.')).toBeTruthy();
  });

  it('lists results: status, platform, robots, products, sample as text, the error and setup details', async () => {
    mockApi({ 'GET /api/admin/shop-requests': () => json({ requests: [active, failed, blocked, setup], maxQueued: 20 }) });
    renderAt('/admin/add-shop');
    const a = (await screen.findByText('https://toys.example.mt')).closest('li')!;
    expect(within(a).getByText('Active')).toBeTruthy();
    expect(within(a).getByText('Shopify')).toBeTruthy();
    expect(within(a).getByText('Allowed, crawl delay 5 s')).toBeTruthy();
    expect(within(a).getByText('50')).toBeTruthy();
    expect(within(a).getByText(/<img src=x onerror=alert\(1\)> Robot/)).toBeTruthy();
    expect(within(a).getByText(/€39\.99/)).toBeTruthy();
    expect(a.querySelector('img, a[href*="toys.example.mt"]')).toBeNull();
    expect(within(a).queryByRole('button', { name: /Retry|Reject/ })).toBeNull();

    const b = screen.getByText('https://closed.example.mt').closest('li')!;
    expect(within(b).getByText('Blocked')).toBeTruthy();
    expect(within(b).getByText('Blocked by Disallow: /products.json (line 3)')).toBeTruthy();

    const s = screen.getByText('https://fashion.example.mt').closest('li')!;
    expect(within(s).getByText('Needs setup')).toBeTruthy();
    expect(within(s).getByText(/PrestaShop/)).toBeTruthy();
    expect(within(s).getByText(/JSON-LD Product data: yes/)).toBeTruthy();
    expect(within(s).getByText(/\/en\/3-clothes/)).toBeTruthy();

    const f = screen.getByText('https://thin.example.mt').closest('li')!;
    expect(within(f).getByText(/Only 4 products/)).toBeTruthy();
  });

  it('retry and reject send the new status and update the item in place', async () => {
    const fetch = mockApi({
      'GET /api/admin/shop-requests': () => json({ requests: [failed, setup], maxQueued: 20 }),
      'PATCH /api/admin/shop-requests/3': () => json({ request: { ...failed, status: 'pending' } }),
      'PATCH /api/admin/shop-requests/5': () => json({ request: { ...setup, status: 'rejected' } }),
    });
    renderAt('/admin/add-shop');
    const f = (await screen.findByText('https://thin.example.mt')).closest('li')!;
    fireEvent.click(within(f).getByRole('button', { name: 'Retry: https://thin.example.mt' }));
    expect(await within(f).findByText('Waiting')).toBeTruthy();
    expect(bodyOf(calls(fetch, 'PATCH', '/api/admin/shop-requests/3')[0]!)).toEqual({ status: 'pending' });
    const s = screen.getByText('https://fashion.example.mt').closest('li')!;
    expect(within(s).queryByRole('button', { name: /Retry/ })).toBeNull();
    fireEvent.click(within(s).getByRole('button', { name: 'Reject: https://fashion.example.mt' }));
    expect(await within(s).findByText('Rejected')).toBeTruthy();
    expect(bodyOf(calls(fetch, 'PATCH', '/api/admin/shop-requests/5')[0]!)).toEqual({ status: 'rejected' });
  });

  it('refreshes every 30 s while a request is waiting or being checked, and stops when none is', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer: AdminShopRequest[] = [base];
    const fetch = mockApi({ 'GET /api/admin/shop-requests': () => json({ requests: answer, maxQueued: 20 }) });
    renderAt('/admin/add-shop');
    await screen.findByText('Waiting');
    expect(calls(fetch, 'GET', '/api/admin/shop-requests')).toHaveLength(1);
    answer = [{ ...base, status: 'checking' }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    await screen.findByText('Checking');
    expect(calls(fetch, 'GET', '/api/admin/shop-requests')).toHaveLength(2);
    answer = [{ ...base, status: 'active', platform: 'shopify', productsFound: 50 }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    await screen.findByText('Active');
    expect(calls(fetch, 'GET', '/api/admin/shop-requests')).toHaveLength(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    });
    await waitFor(() => expect(calls(fetch, 'GET', '/api/admin/shop-requests')).toHaveLength(3));
  });
});
