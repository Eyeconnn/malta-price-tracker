// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Background } from '@/components/site/Background';
import { GlassCard } from '@/components/site/GlassCard';
import { Headline, parseHighlight } from '@/components/site/Headline';
import { ModeProvider, useMode } from '@/components/site/ModeProvider';
import { PriceTag } from '@/components/site/PriceTag';
import { RatingScale } from '@/components/site/RatingScale';
import { ShopBadge, initials } from '@/components/site/ShopBadge';
import { formatDay, formatEuro } from '@/lib/format';
import { daysToBlackFriday, maltaDate, slotFor } from '@/lib/time';
import { DEFAULT_SETTINGS, type PhraseSlot } from '../../src/site/settings.js';

afterEach(cleanup);

const fontSize = (container: HTMLElement, letter: string) =>
  (container.querySelector(`[data-letter="${letter}"]`) as HTMLElement).style.fontSize;

describe('RatingScale', () => {
  it('sizes letters by distance from D', () => {
    const { container } = render(<RatingScale grade="D" sentence="Be careful here." />);
    expect(fontSize(container, 'D')).toBe('54px');
    expect(fontSize(container, 'C')).toBe('30px');
    expect(fontSize(container, 'E')).toBe('30px');
    expect(fontSize(container, 'B')).toBe('24px');
    expect(fontSize(container, 'F')).toBe('24px');
    expect(fontSize(container, 'A')).toBe('19px');
    expect(container.querySelector('[data-letter="D"]')!.getAttribute('data-on')).toBe('true');
  });

  it('sizes letters by distance from F', () => {
    const { container } = render(<RatingScale grade="F" sentence="Avoid its deals." />);
    expect(fontSize(container, 'F')).toBe('54px');
    expect(fontSize(container, 'E')).toBe('30px');
    expect(fontSize(container, 'A')).toBe('12px');
  });

  it('states the grade and sentence as text', () => {
    const { container } = render(<RatingScale grade="D" sentence="Be careful here." />);
    expect(container.textContent).toContain('Rating D: Be careful here.');
    expect(screen.getByText('RATING').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('shows "Not rated yet" with no letter lit when grade is null', () => {
    const { container } = render(<RatingScale grade={null} sentence="Not enough products checked yet." />);
    expect(screen.getByText('Not rated yet')).toBeTruthy();
    for (const l of 'ABCDEF') {
      expect(fontSize(container, l)).toBe('15px');
      expect(container.querySelector(`[data-letter="${l}"]`)!.getAttribute('data-on')).toBe('false');
    }
    expect(container.textContent).not.toMatch(/Rating [A-F]/);
  });
});

describe('slotFor (Europe/Malta)', () => {
  it.each([
    // before the 25 Oct 2026 change: CEST, UTC+2
    ['2026-10-24T03:59:00Z', 'late'], // 05:59
    ['2026-10-24T04:00:00Z', 'morning'], // 06:00
    // 25 Oct: clocks go back at 01:00 UTC, so 03:59Z is 04:59 CET
    ['2026-10-25T03:59:00Z', 'late'],
    ['2026-10-25T04:59:00Z', 'late'], // 05:59 CET
    ['2026-10-25T05:00:00Z', 'morning'], // 06:00 CET
    ['2026-10-26T05:00:00Z', 'morning'], // 06:00 CET
    ['2026-10-26T04:59:00Z', 'late'], // 05:59 CET
    ['2026-10-26T10:59:00Z', 'morning'], // 11:59
    ['2026-10-26T11:00:00Z', 'afternoon'], // 12:00
    ['2026-10-26T16:59:00Z', 'afternoon'], // 17:59
    ['2026-10-26T17:00:00Z', 'evening'], // 18:00
    ['2026-10-26T22:59:00Z', 'evening'], // 23:59
    ['2026-10-26T23:00:00Z', 'late'], // 00:00 on 27 Oct
    // Black Friday week: Malta dates 20 Nov to 27 Nov inclusive
    ['2026-11-24T12:00:00Z', 'bfweek'],
    ['2026-11-19T22:59:00Z', 'evening'], // 19 Nov 23:59
    ['2026-11-19T23:00:00Z', 'bfweek'], // 20 Nov 00:00
    ['2026-11-27T22:59:00Z', 'bfweek'], // 27 Nov 23:59
    ['2026-11-27T23:00:00Z', 'late'], // 28 Nov 00:00
  ] as const)('%s is %s', (iso, slot) => {
    expect(slotFor(new Date(iso))).toBe(slot);
  });

  it('reads the Malta calendar date', () => {
    expect(maltaDate(new Date('2026-11-19T23:00:00Z'))).toBe('2026-11-20');
    expect(maltaDate(new Date('2026-10-25T00:30:00Z'))).toBe('2026-10-25');
  });

  it('counts whole Malta days to Black Friday', () => {
    expect(daysToBlackFriday(new Date('2026-11-22T10:00:00Z'))).toBe(5);
    expect(daysToBlackFriday(new Date('2026-11-26T12:00:00Z'))).toBe(1);
    expect(daysToBlackFriday(new Date('2026-11-26T23:30:00Z'))).toBe(0); // 27 Nov 00:30 Malta
    expect(daysToBlackFriday(new Date('2026-11-27T22:00:00Z'))).toBe(0);
    expect(daysToBlackFriday(new Date('2026-11-28T10:00:00Z'))).toBe(-1);
  });
});

const phrases = (over: Partial<Record<PhraseSlot, string[]>>): Record<PhraseSlot, string[]> => ({ ...DEFAULT_SETTINGS.phrases, ...over });
const AFTERNOON = new Date('2026-10-26T13:00:00Z');

describe('Headline', () => {
  it('renders *word* as an em with no raw asterisks', () => {
    const { container } = render(<Headline phrases={phrases({ afternoon: ['Is that deal *real*?'] })} now={AFTERNOON} />);
    const em = container.querySelector('em');
    expect(em?.textContent).toBe('real');
    expect(container.textContent).toBe('Is that deal real?');
    expect(container.textContent).not.toContain('*');
  });

  it('picks a line from the current slot with the injected random source', () => {
    const lines = ['First *a*.', 'Second *b*.', 'Third *c*.'];
    render(<Headline phrases={phrases({ afternoon: lines })} now={AFTERNOON} random={() => 0.5} />);
    expect(screen.getByRole('heading').textContent).toBe('Second b.');
  });

  it('keeps the same line for the whole visit', () => {
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValue(0.99);
    const p = phrases({ afternoon: ['First *a*.', 'Second *b*.', 'Third *c*.'] });
    const { rerender } = render(<Headline phrases={p} now={AFTERNOON} random={random} />);
    rerender(<Headline phrases={p} now={new Date('2026-10-26T14:00:00Z')} random={random} />);
    expect(screen.getByRole('heading').textContent).toBe('First a.');
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('treats phrases as text, never HTML', () => {
    const { container } = render(<Headline phrases={phrases({ afternoon: ['<img src=x onerror=alert(1)> *<b>hi</b>* 5*3'] })} now={AFTERNOON} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('em')?.textContent).toBe('<b>hi</b>');
    expect(container.textContent).toBe('<img src=x onerror=alert(1)> <b>hi</b> 53');
  });

  it('fills {days} with the days left to Black Friday', () => {
    const p = phrases({ bfweek: ['*{days}* to Black Friday.'] });
    const { unmount } = render(<Headline phrases={p} now={new Date('2026-11-22T10:00:00Z')} />);
    expect(screen.getByRole('heading').textContent).toBe('5 days to Black Friday.');
    expect(screen.getByRole('heading').querySelector('em')?.textContent).toBe('5 days');
    unmount();
    render(<Headline phrases={p} now={new Date('2026-11-26T10:00:00Z')} />);
    expect(screen.getByRole('heading').textContent).toBe('1 day to Black Friday.');
  });

  it('skips {days} lines on Black Friday itself', () => {
    const p = phrases({ bfweek: ['*{days}* to Black Friday.', '*Black Friday* week.'] });
    render(<Headline phrases={p} now={new Date('2026-11-27T10:00:00Z')} random={() => 0} />);
    expect(screen.getByRole('heading').textContent).toBe('Black Friday week.');
  });

  it('falls back to a fixed line when nothing in the slot can be shown', () => {
    render(<Headline phrases={phrases({ bfweek: ['*{days}* to go.'] })} now={new Date('2026-11-27T10:00:00Z')} />);
    expect(screen.getByRole('heading').textContent).toBe('Is that deal real?');
  });

  it('never shows "0 days" with the default phrases on the day', () => {
    for (const r of [0, 0.34, 0.67, 0.99]) {
      const { unmount } = render(<Headline phrases={DEFAULT_SETTINGS.phrases} now={new Date('2026-11-27T10:00:00Z')} random={() => r} />);
      const text = screen.getByRole('heading').textContent ?? '';
      expect(text).not.toMatch(/\b0 days\b|\{days\}/);
      unmount();
    }
  });
});

describe('parseHighlight', () => {
  it('splits marked words and drops stray asterisks', () => {
    expect(parseHighlight('a *b* c *d')).toEqual([
      { text: 'a ', em: false },
      { text: 'b', em: true },
      { text: ' c d', em: false },
    ]);
  });
});

describe('PriceTag', () => {
  it('shows the raised prices on an avoid tag', () => {
    render(<PriceTag kind="avoid" from={70900} to={79900} />);
    expect(screen.getByText('€709.00')).toBeTruthy();
    expect(screen.getByText('€799.00')).toBeTruthy();
    expect(screen.getByText('€709.00').tagName).toBe('S');
    expect(screen.getByText('RAISED')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Raised from €709.00 to €799.00' })).toBeTruthy();
  });

  it('replaces the word RAISED with a label', () => {
    render(<PriceTag kind="avoid" from={70900} to={79900} label="WAS UP" />);
    expect(screen.queryByText('RAISED')).toBeNull();
    expect(screen.getByText('WAS UP')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'WAS UP: from €709.00 to €799.00' })).toBeTruthy();
  });

  it('shows a gold real-deal tag with three decorative sparkles', () => {
    const { container } = render(<PriceTag kind="good" size="sm" />);
    expect(screen.getByRole('img', { name: 'Real deal' })).toBeTruthy();
    expect(container.querySelectorAll('[data-sparkle]')).toHaveLength(3);
    expect(container.firstElementChild!.getAttribute('data-kind')).toBe('good');
  });
});

describe('ShopBadge', () => {
  it('uses initials without a logo', () => {
    render(<ShopBadge name="Digital Zone" />);
    expect(screen.getByRole('img', { name: 'Digital Zone' }).textContent).toBe('DZ');
    expect(initials('scan')).toBe('SC');
    expect(initials('AtoZ Electronics Ltd')).toBe('AE');
    expect(initials('!!!')).toBe('?');
  });

  it('shows the logo and falls back to initials if it fails to load', () => {
    const { container } = render(<ShopBadge name="Digital Zone" logoUrl="https://example.test/dz.png" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'Digital Zone' }).textContent).toBe('DZ');
  });
});

describe('GlassCard and Background', () => {
  it('render a glass card and a decorative background', () => {
    const { container } = render(
      <>
        <Background />
        <GlassCard className="p-4">x</GlassCard>
      </>,
    );
    expect(screen.getByText('x').classList.contains('glass')).toBe(true);
    expect(container.querySelector('.site-bg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

function ModeProbe() {
  const m = useMode();
  return (
    <div>
      <span data-testid="mode">{m.mode}</span>
      <span data-testid="theme">{m.theme}</span>
      <span data-testid="resolved">{m.resolvedTheme}</span>
      <button onClick={() => m.setMode('advanced')}>advanced</button>
      <button onClick={() => m.setTheme('dark')}>dark</button>
      <button onClick={() => m.setTheme('system')}>system</button>
    </div>
  );
}

describe('ModeProvider', () => {
  let listeners: ((e: { matches: boolean }) => void)[];
  let deviceDark: boolean;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    listeners = [];
    deviceDark = false;
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query,
      get matches() {
        return deviceDark;
      },
      addEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.push(l),
      removeEventListener: (_: string, l: (e: { matches: boolean }) => void) => (listeners = listeners.filter((x) => x !== l)),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const text = (id: string) => screen.getByTestId(id).textContent;

  it('defaults to Simple and the device theme', () => {
    render(<ModeProvider><ModeProbe /></ModeProvider>);
    expect(text('mode')).toBe('simple');
    expect(text('theme')).toBe('system');
    expect(text('resolved')).toBe('light');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('remembers mode and theme and applies data-theme', () => {
    render(<ModeProvider><ModeProbe /></ModeProvider>);
    fireEvent.click(screen.getByText('advanced'));
    fireEvent.click(screen.getByText('dark'));
    expect(localStorage.getItem('mode')).toBe('advanced');
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(text('resolved')).toBe('dark');
    fireEvent.click(screen.getByText('system'));
    expect(localStorage.getItem('theme')).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('reads stored values on mount', () => {
    localStorage.setItem('mode', 'advanced');
    localStorage.setItem('theme', 'light');
    render(<ModeProvider><ModeProbe /></ModeProvider>);
    expect(text('mode')).toBe('advanced');
    expect(text('theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('ignores invalid stored values', () => {
    localStorage.setItem('mode', 'expert');
    localStorage.setItem('theme', 'purple');
    render(<ModeProvider><ModeProbe /></ModeProvider>);
    expect(text('mode')).toBe('simple');
    expect(text('theme')).toBe('system');
  });

  it('follows device changes while on system', () => {
    render(<ModeProvider><ModeProbe /></ModeProvider>);
    expect(text('resolved')).toBe('light');
    deviceDark = true;
    act(() => listeners.forEach((l) => l({ matches: true })));
    expect(text('resolved')).toBe('dark');
  });

  it('works when storage throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<ModeProvider><ModeProbe /></ModeProvider>);
    fireEvent.click(screen.getByText('dark'));
    expect(text('theme')).toBe('dark');
    get.mockRestore();
    set.mockRestore();
  });
});

describe('format', () => {
  it('formats euros and days', () => {
    expect(formatEuro(121900)).toBe('€1,219.00');
    expect(formatEuro(70900)).toBe('€709.00');
    expect(formatDay('2026-10-22')).toBe('22 Oct');
    expect(formatDay('2026-10-21T23:30:00Z')).toBe('22 Oct'); // Malta day of the instant
  });
});
