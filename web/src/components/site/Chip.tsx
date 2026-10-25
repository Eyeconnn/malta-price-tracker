import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export type ChipTone = 'good' | 'bad' | 'warn' | 'info' | 'neutral' | 'bf';

const TONES: Record<ChipTone, string> = {
  good: 'bg-good-bg text-good',
  bad: 'bg-bad-bg text-bad',
  warn: 'bg-warn-bg text-warn',
  info: 'bg-info-bg text-info',
  neutral: 'bg-neutral-bg text-neutral',
  bf: 'bg-ink font-bold text-on-ink',
};

/** A small pill of text on a tinted ground: verdict words, stock, "Black Friday". Never a dot. */
export function Chip({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: ChipTone }) {
  return (
    <span
      className={cn('inline-flex h-6 w-fit items-center gap-1.5 rounded-full px-2.5 text-xs leading-none font-semibold whitespace-nowrap', TONES[tone], className)}
      {...props}
    />
  );
}
