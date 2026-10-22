// @vitest-environment jsdom
// The typing placeholder of the main search (web/src/lib/useTypingPlaceholder.ts + SearchBox).
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSearch, SearchBox } from '@/components/site/SearchBox';
import { SEARCH_EXAMPLES } from '@/lib/searchExamples';
import { TYPING, useTypingPlaceholder } from '@/lib/useTypingPlaceholder';

const FAST = { typeMs: 10, eraseMs: 5, holdMs: 100, gapMs: 20 };
const all = Object.values(SEARCH_EXAMPLES).flat() as string[];
const categoryOf = (text: string) => Object.entries(SEARCH_EXAMPLES).find(([, list]) => (list as readonly string[]).includes(text))![0];

function setMedia(reduced: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes('prefers-reduced-motion') ? reduced : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia;
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

/** Runs the hook one millisecond at a time and records every distinct text it shows. */
function record(ms: number) {
  const hook = renderHook(({ on }) => useTypingPlaceholder(on, { timings: FAST }), { initialProps: { on: true } });
  const seen: string[] = [hook.result.current.text];
  for (let t = 0; t < ms; t++) {
    tick(1);
    if (seen.at(-1) !== hook.result.current.text) seen.push(hook.result.current.text);
  }
  return { hook, seen };
}

/** Inside the first example's typing (gap, then a few letters): never the empty gap or the hold/erase phases. */
const TYPING_WINDOW_FAST = FAST.gapMs + FAST.typeMs * 3;
const TYPING_WINDOW = TYPING.gapMs + TYPING.typeMs * 3;

beforeEach(() => {
  // a fixed example order: the first example is the first laptops one, so every sample instant is predictable
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.useFakeTimers();
  setMedia(false);
  setVisibility('visible');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useTypingPlaceholder', () => {
  it('uses the specified default timings', () => {
    expect(TYPING.typeMs).toBe(70);
    expect(TYPING.eraseMs).toBe(35);
    expect(TYPING.holdMs).toBe(1600);
  });

  it('types an example letter by letter, erases it, then types one of another category', () => {
    const { seen } = record(1500);
    const full = seen.filter((t) => all.includes(t));
    expect(full.length).toBeGreaterThanOrEqual(3);
    // letter by letter: the first example was reached through each of its prefixes
    for (let n = 1; n <= full[0]!.length; n++) expect(seen).toContain(full[0]!.slice(0, n));
    // erased back to empty between examples
    expect(seen.filter((t) => t === '').length).toBeGreaterThanOrEqual(2);
    // consecutive examples come from different categories
    for (let i = 1; i < full.length; i++) expect(categoryOf(full[i]!)).not.toBe(categoryOf(full[i - 1]!));
  });

  it('holds the finished example for the hold time before erasing', () => {
    const hook = renderHook(() => useTypingPlaceholder(true, { timings: FAST, random: () => 0 }));
    const full = SEARCH_EXAMPLES.laptops[0];
    tick(FAST.gapMs + FAST.typeMs * (full.length - 1));
    expect(hook.result.current.text).toBe(full);
    tick(FAST.holdMs - 1);
    expect(hook.result.current.text).toBe(full);
    tick(1 + FAST.eraseMs);
    expect(hook.result.current.text).toBe(full.slice(0, full.length - 2));
  });

  it('shows nothing and holds no timer while inactive, and starts again from empty', () => {
    const { hook } = record(TYPING_WINDOW_FAST);
    expect(hook.result.current.text).not.toBe('');
    hook.rerender({ on: false });
    expect(hook.result.current.text).toBe('');
    expect(hook.result.current.caret).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    tick(2000);
    expect(hook.result.current.text).toBe('');
    hook.rerender({ on: true });
    expect(hook.result.current.text).toBe('');
    expect(hook.result.current.caret).toBe(true);
  });

  it('reduced motion: one static example, no caret, no timers', () => {
    setMedia(true);
    const hook = renderHook(() => useTypingPlaceholder(true, { timings: FAST }));
    const text = hook.result.current.text;
    expect(all).toContain(text);
    expect(hook.result.current.caret).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    tick(5000);
    expect(hook.result.current.text).toBe(text);
  });

  it('pauses while the tab is hidden and goes on when it is visible again', () => {
    const { hook } = record(TYPING_WINDOW_FAST);
    expect(hook.result.current.text).not.toBe('');
    act(() => setVisibility('hidden'));
    expect(vi.getTimerCount()).toBe(0);
    const frozen = hook.result.current.text;
    tick(5000);
    expect(hook.result.current.text).toBe(frozen);
    act(() => setVisibility('visible'));
    expect(vi.getTimerCount()).toBe(1);
    tick(2000);
    expect(hook.result.current.text).not.toBe(frozen);
  });

  it('does not start while the tab is already hidden', () => {
    setVisibility('hidden');
    renderHook(() => useTypingPlaceholder(true, { timings: FAST }));
    expect(vi.getTimerCount()).toBe(0);
    act(() => setVisibility('visible'));
    expect(vi.getTimerCount()).toBe(1);
  });

  it('clears its timer and listener on unmount', () => {
    const { hook } = record(120);
    expect(vi.getTimerCount()).toBe(1);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
    // a visibility change after unmount starts nothing
    setVisibility('hidden');
    setVisibility('visible');
    expect(vi.getTimerCount()).toBe(0);
  });
});

function renderBox(props: Partial<React.ComponentProps<typeof SearchBox>> = {}) {
  const utils = render(
    <MemoryRouter>
      <SearchBox value="" onChange={() => {}} onSubmit={() => {}} animated {...props} />
    </MemoryRouter>,
  );
  return { ...utils, input: screen.getByRole('searchbox') as HTMLInputElement };
}
const overlay = () => screen.queryByTestId('search-example');

describe('SearchBox with the typing placeholder', () => {
  it('types into an aria-hidden overlay and keeps a stable accessible name', () => {
    const { input } = renderBox();
    expect(input.getAttribute('placeholder')).toBeNull();
    tick(TYPING_WINDOW);
    const el = overlay()!;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.textContent!.length).toBeGreaterThan(0);
    expect(el.closest('[aria-live], [role="status"]')).toBeNull();
    // the name does not change with the text
    expect(screen.getByRole('searchbox', { name: 'Search a product' })).toBe(input);
  });

  it('stops and shows no text while the input is focused, and starts again from empty on blur', () => {
    const { input } = renderBox();
    tick(1000);
    expect(overlay()!.textContent!.length).toBeGreaterThan(0);
    fireEvent.focus(input);
    expect(overlay()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.blur(input);
    expect(overlay()!.textContent).toBe('');
  });

  it('shows no overlay and runs no timer while the input has text', () => {
    const { input, rerender } = renderBox({ value: 'dyson' });
    expect(overlay()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(input.value).toBe('dyson');
    rerender(
      <MemoryRouter>
        <SearchBox value="" onChange={() => {}} onSubmit={() => {}} animated />
      </MemoryRouter>,
    );
    expect(overlay()).not.toBeNull();
  });

  it('reduced motion: one static example with no caret', () => {
    setMedia(true);
    renderBox();
    const el = overlay()!;
    expect(all).toContain(el.textContent);
    expect(el.querySelector('.search-caret')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a blinking caret after the text while animating', () => {
    renderBox();
    expect(overlay()!.querySelector('.search-caret')).not.toBeNull();
  });

  it('keeps the static placeholder attribute when not animated (shop search)', () => {
    const { input } = renderBox({ animated: false, placeholder: 'Search Alpha Shop' });
    expect(input.getAttribute('placeholder')).toBe('Search Alpha Shop');
    expect(overlay()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unmounting clears the timers', () => {
    const { unmount } = renderBox();
    tick(300);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('LiveSearch animates only when asked to', () => {
    const { unmount } = render(
      <MemoryRouter>
        <LiveSearch animated />
      </MemoryRouter>,
    );
    expect(overlay()).not.toBeNull();
    unmount();
    render(
      <MemoryRouter>
        <LiveSearch placeholder="Search Alpha Shop" />
      </MemoryRouter>,
    );
    expect(overlay()).toBeNull();
    expect(screen.getByRole('searchbox').getAttribute('placeholder')).toBe('Search Alpha Shop');
  });
});
