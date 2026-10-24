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

  it.each([['**'], ['*'], ['***'], ['  '], ['* *']])('treats %j as unusable and falls back', (bad) => {
    render(<Headline phrases={phrases({ afternoon: [bad] })} now={AFTERNOON} />);
    expect(screen.getByRole('heading').textContent).toBe('Is that deal real?');
  });

  it('only picks among lines with visible text', () => {
    render(<Headline phrases={phrases({ afternoon: ['**', 'Only *this*.', '*'] })} now={AFTERNOON} random={() => 0} />);
    expect(screen.getByRole('heading').textContent).toBe('Only this.');
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

  it.each([[''], ['**'], ['***'], ['*']])('gives no segments for %j', (line) => {
    expect(parseHighlight(line)).toEqual([]);
  });

  it('pairs asterisks left to right in nested-looking markup', () => {
    expect(parseHighlight('*a *b* c*')).toEqual([
      { text: 'a ', em: true },
      { text: 'b', em: false },
      { text: ' c', em: true },
    ]);
  });

  it('handles a 5,000-character line', () => {
    const marked = '*a*'.repeat(1666) + 'xy'; // 5,000 chars
    expect(marked).toHaveLength(5000);
    const segs = parseHighlight(marked);
    expect(segs).toHaveLength(1667);
    expect(segs.filter((s) => s.em)).toHaveLength(1666);
    const unclosed = '*' + 'a'.repeat(4999);
    expect(parseHighlight(unclosed)).toEqual([{ text: 'a'.repeat(4999), em: false }]);
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

  it.each([[0], [-100], [null], [Number.NaN]])('never shows a from price of %s; the avoid tag shows only the price now', (from) => {
    const { container } = render(<PriceTag kind="avoid" from={from} to={79900} />);
    expect(container.textContent).not.toContain('€0.00');
    expect(container.textContent).not.toContain('-');
    expect(container.querySelector('s')).toBeNull();
    expect(screen.getByText('€799.00')).toBeTruthy();
    expect(screen.getByText('RAISED')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Raised, now €799.00' })).toBeTruthy();
  });

  it.each([[0], [-100], [null]])('never shows a price now of %s', (to) => {
    const { container } = render(<PriceTag kind="avoid" from={70900} to={to} />);
    expect(container.textContent).not.toMatch(/€/);
    expect(screen.getByText('RAISED')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Raised' })).toBeTruthy();
  });

  it('never puts €0.00 in a good tag label', () => {
    render(<PriceTag kind="good" from={0} to={0} />);
    expect(screen.getByRole('img', { name: 'Real deal' })).toBeTruthy();
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

  const LOGO = `/img/${'a'.repeat(64)}.webp`;

  it('shows the logo image named after the shop, lazy, sized, contained on a neutral background', () => {
    const { container } = render(<ShopBadge name="Digital Zone" logoUrl={LOGO} />);
    const img = screen.getByRole('img', { name: 'Digital Zone' }) as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe(LOGO);
    expect(img.getAttribute('loading')).toBe('lazy');
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['38', '38']);
    expect(img.className).toContain('object-contain');
    expect(container.firstElementChild!.className).toContain('bg-white');
    // the circle is not a second image of the same name
    expect(container.firstElementChild!.getAttribute('role')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('has an empty alt and hides the circle from screen readers when the name is next to it', () => {
    const { container } = render(<ShopBadge name="Digital Zone" logoUrl={LOGO} size="sm" decorative />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('');
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['28', '28']);
    expect(container.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
    // without a logo too: the initials are decorative
    const { container: plain } = render(<ShopBadge name="Scan" decorative />);
    expect(plain.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
    expect(plain.textContent).toBe('SC');
  });

  it('draws a wide logo as a pill of the same height, at most 4 times as wide, and a square-ish one as a circle', () => {
    const { container } = render(<ShopBadge name="Telecom" logoUrl={LOGO} logoAspect={7.04} decorative />);
    const pill = container.firstElementChild as HTMLElement;
    const img = container.querySelector('img')!;
    expect(pill.getAttribute('data-shape')).toBe('pill');
    expect(pill.style.width).toBe('152px');
    expect(pill.className).toContain('h-[38px]');
    expect(pill.className).toContain('rounded-full');
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['152', '38']);
    expect(img.className).toContain('object-contain');

    const { container: small } = render(<ShopBadge name="Hudson" logoUrl={LOGO} logoAspect={2} size="sm" />);
    expect((small.firstElementChild as HTMLElement).style.width).toBe('56px');
    expect(small.querySelector('img')!.getAttribute('width')).toBe('56');

    for (const aspect of [1.4, 1, null]) {
      const { container: round } = render(<ShopBadge name="Scan" logoUrl={LOGO} logoAspect={aspect} />);
      const el = round.firstElementChild as HTMLElement;
      expect(el.getAttribute('data-shape'), String(aspect)).toBe('circle');
      expect(el.style.width).toBe('');
    }
  });

  it('a wide logo that fails to load falls back to the initials circle', () => {
    const { container } = render(<ShopBadge name="Digital Zone" logoUrl={LOGO} logoAspect={5} />);
    fireEvent.error(container.querySelector('img')!);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('data-shape')).toBe('circle');
    expect(el.style.width).toBe('');
    expect(el.textContent).toBe('DZ');
  });

  it('falls back to initials if the logo fails to load', () => {
    const { container } = render(<ShopBadge name="Digital Zone" logoUrl={LOGO} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'Digital Zone' }).textContent).toBe('DZ');
  });

  it('shows initials when the logo is null', () => {
    const { container } = render(<ShopBadge name="Digital Zone" logoUrl={null} />);
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
