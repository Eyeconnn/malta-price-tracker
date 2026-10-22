// @vitest-environment jsdom
// The "Something wrong?" dialog (web/src/components/site/ReportButton.tsx) against a mocked POST /api/reports.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMAIL_NOTE, RATE_LIMITED, rateLimitedText, ReportButton, SEND_FAILED } from '@/components/site/ReportButton';

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function mockPost(answer: () => Response | Promise<Response>) {
  const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => answer());
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open(props: Partial<Parameters<typeof ReportButton>[0]> = {}) {
  render(<ReportButton targetType="product" targetId={70} about="Lenovo IdeaPad at Scan" {...props} />);
  fireEvent.click(screen.getByRole('button', { name: props.ariaLabel ?? props.label ?? props.title ?? 'Something wrong?' }));
  return screen.findByRole('dialog');
}

describe('ReportButton', () => {
  it('opens a form with a labelled reason group, optional details with a counter and an optional email', async () => {
    const dialog = await open();
    expect(within(dialog).getByRole('heading', { name: 'Something wrong?' })).toBeTruthy();
    expect(within(dialog).getByText('Lenovo IdeaPad at Scan')).toBeTruthy();
    const group = within(dialog).getByRole('radiogroup', { name: 'What is wrong?' });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['wrong-price', 'not-black-friday', 'wrong-match', 'other']);
    expect(radios[0]!.checked).toBe(true);
    const details = within(dialog).getByRole('textbox', { name: 'Details (optional)' }) as HTMLTextAreaElement;
    expect(details.maxLength).toBe(1000);
    expect(within(dialog).getByText('0 of 1000 characters')).toBeTruthy();
    fireEvent.change(details, { target: { value: 'abc' } });
    expect(within(dialog).getByText('3 of 1000 characters')).toBeTruthy();
    const email = within(dialog).getByRole('textbox', { name: 'Email (optional)' });
    expect(email.getAttribute('aria-describedby')).toBe(within(dialog).getByText(EMAIL_NOTE).id);
    expect(EMAIL_NOTE).toBe('Only used to reply to you about this report.');
  });

  it('posts the report as JSON and shows a thank-you message that takes focus', async () => {
    const fetch = mockPost(() => json({ ok: true }, 201));
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'It is not a Black Friday deal' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Details (optional)' }), { target: { value: '  Same price all year.  ' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Email (optional)' }), { target: { value: ' me@example.com ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    const thanks = await within(dialog).findByRole('status');
    expect(thanks.textContent).toContain('Thank you, your report has been sent.');
    await waitFor(() => expect(document.activeElement).toBe(thanks));
    // the intro is for the form only
    expect(within(dialog).queryByText(/Tell us what looks wrong/)).toBeNull();
    expect(within(dialog).getByText('Lenovo IdeaPad at Scan')).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/reports');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      targetType: 'product',
      targetId: 70,
      reason: 'not-black-friday',
      message: 'Same price all year.',
      email: 'me@example.com',
    });
  });

  it('leaves out empty details and email', async () => {
    const fetch = mockPost(() => json({ ok: true }, 201));
    const dialog = await open({ targetType: 'shop', targetId: 3 });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    await within(dialog).findByRole('status');
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ targetType: 'shop', targetId: 3, reason: 'wrong-price' });
  });

  it('says so when rate limited, and keeps the form', async () => {
    mockPost(() => json({ error: 'rate limited' }, 429));
    const dialog = await open();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Details (optional)' }), { target: { value: 'kept' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(RATE_LIMITED);
    expect(RATE_LIMITED).toBe('Several reports have come from your network in the last hour. Please try again later.');
    expect((within(dialog).getByRole('textbox', { name: 'Details (optional)' }) as HTMLTextAreaElement).value).toBe('kept');
    expect(within(dialog).queryByRole('status')).toBeNull();
  });

  it('names a rough wait from retry-after when rate limited', async () => {
    mockPost(() => json({ error: 'rate limited' }, 429, { 'retry-after': '1800' }));
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Several reports have come from your network in the last hour. Please try again in about 30 minutes.',
    );
  });

  it('rounds the wait up to whole minutes, and falls back to "later" without a usable retry-after', () => {
    expect(rateLimitedText(30)).toBe('Several reports have come from your network in the last hour. Please try again in about 1 minute.');
    expect(rateLimitedText(61)).toBe('Several reports have come from your network in the last hour. Please try again in about 2 minutes.');
    expect(rateLimitedText(null)).toBe(RATE_LIMITED);
    expect(rateLimitedText(Number.NaN)).toBe(RATE_LIMITED);
    expect(rateLimitedText(0)).toBe(RATE_LIMITED);
    expect(rateLimitedText(7200)).toBe(RATE_LIMITED);
  });

  it('asks to retry on any other failure, and a retry can succeed', async () => {
    let calls = 0;
    mockPost(() => {
      calls++;
      if (calls === 1) throw new TypeError('network down');
      if (calls === 2) return json({ error: 'internal error' }, 500);
      return json({ ok: true }, 201);
    });
    const dialog = await open();
    const send = () => fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    send();
    expect((await within(dialog).findByRole('alert')).textContent).toBe(SEND_FAILED);
    send();
    await waitFor(() => expect(calls).toBe(2));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(SEND_FAILED);
    send();
    expect(await within(dialog).findByRole('status')).toBeTruthy();
  });

  it('checks the email before sending', async () => {
    const fetch = mockPost(() => json({ ok: true }, 201));
    const dialog = await open();
    const email = within(dialog).getByRole('textbox', { name: 'Email (optional)' });
    fireEvent.change(email, { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    expect(await within(dialog).findByText('Enter an email address like name@example.com, or leave it empty.')).toBeTruthy();
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(email);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows a field error the server names', async () => {
    mockPost(() => json({ error: 'message' }, 400));
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    expect(await within(dialog).findByText('Details can be at most 1000 characters.')).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: 'Details (optional)' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('starts with a fresh form when opened again', async () => {
    mockPost(() => json({ ok: true }, 201));
    let dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    const thanks = await within(dialog).findByRole('status');
    fireEvent.click(within(thanks).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Something wrong?' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Send report' })).toBeTruthy();
    expect(within(dialog).queryByRole('status')).toBeNull();
  });

  it('offers match reasons with wrong-match first and a compact, named button', async () => {
    const dialog = await open({ targetType: 'match', targetId: 9, title: 'Wrong match?', label: 'Report', ariaLabel: 'Report a wrong match with Scan', compact: true });
    expect(within(dialog).getByRole('heading', { name: 'Wrong match?' })).toBeTruthy();
    const radios = within(dialog).getAllByRole('radio') as HTMLInputElement[];
    expect(radios[0]!.value).toBe('wrong-match');
    expect(radios[0]!.checked).toBe(true);
  });
});
