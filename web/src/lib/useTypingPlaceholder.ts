import { useEffect, useRef, useState } from 'react';
import type { CategorySlug } from '../../../src/site/categories.js';
import { nextExample, staticExample } from '@/lib/searchExamples';
import { useMediaQuery } from '@/lib/useMediaQuery';

export type TypingTimings = {
  /** per typed letter */
  typeMs: number;
  /** per erased letter */
  eraseMs: number;
  /** a finished example stays this long */
  holdMs: number;
  /** empty pause before the next example starts */
  gapMs: number;
};

export const TYPING: Readonly<TypingTimings> = { typeMs: 70, eraseMs: 35, holdMs: 1600, gapMs: 400 };

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export type TypingOptions = {
  timings?: TypingTimings;
  /** random source; injectable for tests */
  random?: () => number;
};

export type TypingPlaceholder = {
  /** what to show now; '' while not active */
  text: string;
  /** whether to show the blinking caret (only while typing animation runs) */
  caret: boolean;
};

/**
 * The text of an animated placeholder: types an example letter by letter, holds it, erases it, then
 * types one from the next category. Runs only while `active` and the tab is visible; with reduced
 * motion it returns one static example and starts no timer. One timeout is pending at a time and
 * it is cleared on unmount, when `active` ends and while the tab is hidden.
 */
export function useTypingPlaceholder(active: boolean, options: TypingOptions = {}): TypingPlaceholder {
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY);
  const opts = useRef(options);
  opts.current = options;
  const [still] = useState(() => staticExample(options.random));
  const [text, setText] = useState('');
  const animate = active && !reduced;

  useEffect(() => {
    if (!animate) return;
    const { typeMs, eraseMs, holdMs, gapMs } = opts.current.timings ?? TYPING;
    const random = opts.current.random ?? Math.random;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let phase: 'pick' | 'type' | 'erase' = 'pick';
    let category: CategorySlug | null = null;
    let example = '';
    let shown = 0;

    const later = (ms: number) => {
      timer = setTimeout(step, ms);
    };
    function step() {
      timer = undefined;
      if (phase === 'pick') {
        const next = nextExample(category, random);
        category = next.category;
        example = next.text;
        shown = 0;
        phase = 'type';
      }
      if (phase === 'type') {
        shown += 1;
        setText(example.slice(0, shown));
        if (shown < example.length) return later(typeMs);
        phase = 'erase';
        return later(holdMs);
      }
      shown -= 1;
      setText(example.slice(0, shown));
      if (shown > 0) return later(eraseMs);
      phase = 'pick';
      later(gapMs);
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(timer);
        timer = undefined;
      } else if (timer === undefined) {
        later(typeMs);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState !== 'hidden') later(gapMs);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      setText('');
    };
  }, [animate]);

  if (!active) return { text: '', caret: false };
  return reduced ? { text: still, caret: false } : { text, caret: true };
}
