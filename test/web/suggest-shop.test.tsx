// @vitest-environment jsdom
// "Missing a shop?" on /shops (web/src/components/site/SuggestShop.tsx) against a mocked POST /api/shop-suggestions.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUEUE_FULL, SEND_FAILED, SuggestShop, suggestLimitText } from '@/components/site/SuggestShop';
import { REASON_TEXT, SCOPE_NOTE } from '../../src/shop-requests/reasons.js';

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function mockPost(answer: () => Response) {
  const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => answer());
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function suggest(address: string) {
  render(
    <MemoryRouter>
      <SuggestShop />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Shop web address' }), { target: { value: address } });
  fireEvent.click(screen.getByRole('button', { name: 'Suggest shop' }));
  return screen.findByRole('status');
}

describe('SuggestShop', () => {
  it('posts the address and says a new shop will be checked, clearing the field', async () => {
    const fetch = mockPost(() => json({ outcome: 'queued' }, 201));
    const status = await suggest('  www.newshop.com.mt ');
    expect(await screen.findByText('Thanks, we will check newshop.com.mt.')).toBeTruthy();
    expect(status.textContent).toMatch(/within about 15 minutes/);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/shop-suggestions');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ url: 'www.newshop.com.mt' });
    expect((screen.getByRole('textbox', { name: 'Shop web address' }) as HTMLInputElement).value).toBe('');
  });

  it('links a shop that is already on the site', async () => {
    mockPost(() => json({ outcome: 'listed', shop: { slug: 'klikk', name: 'Klikk' } }, 200));
    await suggest('klikk.com.mt');
    expect(await screen.findByText('Klikk is already on the site.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See Klikk' }).getAttribute('href')).toBe('/shops/klikk');
  });

  it('explains why a shop cannot be tracked, with the project rules', async () => {
    mockPost(() => json({ outcome: 'unavailable', reason: 'bot_protection', ...REASON_TEXT.bot_protection, scope: SCOPE_NOTE }, 200));
    const status = await suggest('decathlon.mt');
    expect(await screen.findByText('We cannot track decathlon.mt: the shop blocks automated visitors.')).toBeTruthy();
    expect(status.textContent).toContain(REASON_TEXT.bot_protection.text);
    expect(status.textContent).toContain(SCOPE_NOTE);
  });

  it('a shop being checked, or known without a reason', async () => {
    mockPost(() => json({ outcome: 'checking' }, 200));
    await suggest('pending.com.mt');
    expect(await screen.findByText('pending.com.mt is already waiting to be checked.')).toBeTruthy();
    cleanup();
    mockPost(() => json({ outcome: 'known' }, 200));
    await suggest('agenda.com.mt');
    expect(await screen.findByText('agenda.com.mt is already on our list but is not shown on the site yet.')).toBeTruthy();
  });

  it('a bad address is explained without sending anything', async () => {
    const fetch = mockPost(() => json({}, 500));
    await suggest('http://10.0.0.1');
    expect(await screen.findByText("Use the shop's name, not an IP address.")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Shop web address' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('the daily limit, a full queue and other failures', async () => {
    mockPost(() => json({ error: 'rate limited' }, 429, { 'retry-after': '5400' }));
    await suggest('a.com.mt');
    expect(await screen.findByText(suggestLimitText(5400))).toBeTruthy();
    expect(suggestLimitText(5400)).toBe('Several shops have been suggested from your network today. Please try again in about 2 hours.');
    cleanup();
    mockPost(() => json({ error: 'queue full' }, 503));
    await suggest('a.com.mt');
    expect(await screen.findByText(QUEUE_FULL)).toBeTruthy();
    cleanup();
    mockPost(() => json({ error: 'oops' }, 500));
    await suggest('a.com.mt');
    expect(await screen.findByText(SEND_FAILED)).toBeTruthy();
  });
});
