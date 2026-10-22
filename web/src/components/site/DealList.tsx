import type { ReactNode } from 'react';
import { DealCard } from '@/components/site/DealCard';
import type { Card } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Deal cards: one column on a phone, three from 768px. */
export function DealList({ cards, className }: { cards: Card[]; className?: string }) {
  return (
    <ul className={cn('m-0 grid list-none gap-3 p-0 md:grid-cols-3', className)}>
      {cards.map((c) => (
        <li key={c.id} className="min-w-0">
          <DealCard card={c} />
        </li>
      ))}
    </ul>
  );
}

/** Placeholder tiles the size of deal cards, so the page does not jump when the cards arrive. */
export function DealListSkeleton({ count, className }: { count: number; className?: string }) {
  return (
    <ul aria-hidden="true" className={cn('m-0 grid list-none gap-3 p-0 md:grid-cols-3', className)}>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="glass min-h-40 opacity-60" />
      ))}
    </ul>
  );
}

/** A short message in a glass panel: errors, empty lists. */
export function Notice({ title, children, action, className }: { title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('glass flex flex-col items-start gap-2 p-5', className)}>
      <p className="font-semibold">{title}</p>
      {children && <div className="text-sm text-muted-foreground">{children}</div>}
      {action}
    </div>
  );
}
