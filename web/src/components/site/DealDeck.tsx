import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DealCard } from '@/components/site/DealCard';
import { Button } from '@/components/ui/button';
import type { Card } from '@/lib/api';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { REDUCED_MOTION_QUERY } from '@/lib/useTypingPlaceholder';
import { cn } from '@/lib/utils';

/** Cards shown at a time. */
export const DECK_SIZE = 3;
/** A new set slides in after this long. */
export const DECK_EVERY_MS = 8000;
const OUT_MS = 360;
const IN_MS = 680;

/**
 * The paging of a deck: which set is shown, the slide phase, and the controls. The set changes every 8 seconds
 * unless paused, the pointer or keyboard focus is inside (`hold`), or the visitor prefers reduced motion; the old
 * cards slide off (0.36s) and the new ones slide in (0.5s).
 */
export function useDeck(count: number) {
  const pages = Math.max(1, Math.ceil(count / DECK_SIZE));
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY);
  const [page, setPage] = useState(0);
  const [phase, setPhase] = useState<'in' | 'out' | null>(null);
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const go = useCallback(
    (delta: number) => {
      if (pages < 2) return;
      window.clearTimeout(timer.current);
      if (reduced) {
        setPage((p) => (p + delta + pages) % pages);
        return;
      }
      setPhase('out');
      timer.current = window.setTimeout(() => {
        setPage((p) => (p + delta + pages) % pages);
        setPhase('in');
        // the last card lands at 0.14s + 0.5s
        timer.current = window.setTimeout(() => setPhase(null), IN_MS);
      }, OUT_MS);
    },
    [pages, reduced],
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (page >= pages) setPage(0);
  }, [page, pages]);

  const rotating = pages > 1 && !paused && !held && !reduced;
  useEffect(() => {
    if (!rotating) return;
    const t = window.setInterval(() => go(1), DECK_EVERY_MS);
    return () => window.clearInterval(t);
  }, [rotating, go]);

  return { page: Math.min(page, pages - 1), pages, phase, paused, setPaused, setHeld, go, reduced };
}

/** The pause / play icon button of a deck. */
export function PauseButton({ paused, onToggle, what }: { paused: boolean; onToggle: () => void; what: string }) {
  return (
    <Button variant="outline" size="icon" aria-pressed={paused} aria-label={`${paused ? 'Play' : 'Pause'} ${what}`} onClick={onToggle}>
      {paused ? <Play aria-hidden="true" className="size-4 fill-current" /> : <Pause aria-hidden="true" className="size-4 fill-current" />}
    </Button>
  );
}

/** Which set is shown, as short bars (the current one longer and dark). Not dots. */
export function PageMarkers({ page, pages }: { page: number; pages: number }) {
  if (pages < 2) return null;
  return (
    <span role="img" aria-label={`Showing set ${page + 1} of ${pages}`} className="inline-flex items-center gap-1.5">
      {Array.from({ length: pages }, (_, i) => (
        <span key={i} className={cn('h-1 rounded-full transition-[width,background-color] duration-200', i === page ? 'w-[22px] bg-ink' : 'w-3 bg-line-strong')} />
      ))}
    </span>
  );
}

/**
 * Three deal cards at a time. `deck`: the paging from useDeck, shared with the controls that sit in the heading.
 * Pointer or keyboard focus inside holds the rotation.
 */
export function DealDeck({ cards, deck, className }: { cards: Card[]; deck: ReturnType<typeof useDeck>; className?: string }) {
  const shown = cards.slice(deck.page * DECK_SIZE, deck.page * DECK_SIZE + DECK_SIZE);
  return (
    <ul
      data-phase={deck.phase ?? undefined}
      onPointerEnter={() => deck.setHeld(true)}
      onPointerLeave={() => deck.setHeld(false)}
      onFocus={() => deck.setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) deck.setHeld(false);
      }}
      className={cn('deck m-0 grid list-none gap-4 p-0 md:grid-cols-3', className)}
    >
      {shown.map((c) => (
        <li key={c.id} className="flex min-w-0 flex-col [&>*]:flex-1">
          <DealCard card={c} />
        </li>
      ))}
    </ul>
  );
}
