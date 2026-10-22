import { useState } from 'react';
import type { PhraseSlot } from '../../../../src/site/settings.js';
import { daysToBlackFriday, slotFor } from '@/lib/time';
import { cn } from '@/lib/utils';

/** Shown when the slot has no line that can be used right now. */
export const FALLBACK_LINE = 'Is that deal *real*?';

export type Segment = { text: string; em: boolean };

/**
 * Splits `*word*` markup into plain and highlighted segments. Phrases are admin-edited, so they
 * are only ever rendered as text; a stray `*` without a partner is dropped.
 */
export function parseHighlight(line: string): Segment[] {
  const out: Segment[] = [];
  const plain = (text: string) => {
    const t = text.replaceAll('*', '');
    if (t) out.push({ text: t, em: false });
  };
  let last = 0;
  for (const m of line.matchAll(/\*([^*]+)\*/g)) {
    plain(line.slice(last, m.index));
    out.push({ text: m[1]!, em: true });
    last = m.index + m[0].length;
  }
  plain(line.slice(last));
  return out;
}

/** What `{days}` becomes in a phrase: "1 day", "5 days". */
function daysText(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

export type HeadlineProps = {
  phrases: Record<PhraseSlot, string[]>;
  now: Date;
  /** random source in [0, 1), read once per mount (one line per visit) */
  random?: () => number;
  className?: string;
};

/**
 * The welcome line: one phrase from the current Malta time slot, picked once per visit. `{days}`
 * becomes the days left to Black Friday ("5 days", "1 day"); lines using it are skipped on and
 * after the day itself. `*word*` is highlighted with a sparkle; the line flips in like a tag.
 */
export function Headline({ phrases, now, random = Math.random, className }: HeadlineProps) {
  const [pick] = useState(random);
  const days = daysToBlackFriday(now);
  const usable = (phrases[slotFor(now)] ?? []).filter((l) => l.trim() !== '' && (days > 0 || !l.includes('{days}')));
  const line = usable.length > 0 ? usable[Math.min(usable.length - 1, Math.floor(pick * usable.length))]! : FALLBACK_LINE;
  const segments = parseHighlight(line.replaceAll('{days}', daysText(days)));

  return (
    <h1 className={cn('headline text-balance text-3xl font-extrabold tracking-tight sm:text-4xl', className)}>
      <span className="headline-flip">
        {segments.map((s, i) =>
          s.em ? (
            <em key={i} className="headline-em">
              {s.text}
            </em>
          ) : (
            s.text
          ),
        )}
      </span>
    </h1>
  );
}
