import { TriangleAlert } from 'lucide-react';
import { useId } from 'react';
import { Link } from 'react-router';
import { useMode } from '@/components/site/ModeProvider';
import { PriceTag, type PriceTagProps } from '@/components/site/PriceTag';
import { ShopBadge } from '@/components/site/ShopBadge';
import type { Card } from '@/lib/api';
import { listingPath } from '@/lib/links';
import { formatDay, formatEuro } from '@/lib/format';
import { cn } from '@/lib/utils';

export const NO_PRICE = 'Price not shown by the shop';

/**
 * Which avoid rule a card met, from the facts it carries: its price rose recently, its was price
 * rose recently, or (neither) its was price is above the prices it was sold at. 'other' when the
 * card carries too little to tell.
 */
export type AvoidKind = 'price' | 'was' | 'was-high' | 'other';

export function avoidKind(c: Card): AvoidKind {
  if (c.raisedFrom && c.priceCents !== null) return 'price';
  if (c.wasRaisedFromCents !== null && c.wasCents !== null) return 'was';
  if (c.wasCents !== null && c.priceCents !== null && c.wasCents > c.priceCents) return 'was-high';
  return 'other';
}

const AVOID_WHAT: Record<AvoidKind, string> = {
  price: 'price raised',
  was: 'was price raised',
  'was-high': 'was price above its recent prices',
  other: 'deal to avoid',
};

/** What an avoid card is about, as a short label: "Price raised", "Was price raised", ... */
export function avoidSummary(c: Card): string {
  const what = AVOID_WHAT[avoidKind(c)];
  return what.charAt(0).toUpperCase() + what.slice(1);
}

/** The banner line of a Black Friday avoid card, e.g. "Marked Black Friday, price raised". */
export function alarmText(c: Card): string {
  return `Marked Black Friday, ${AVOID_WHAT[avoidKind(c)]}`;
}

/** One short fact about what changed, shown in Simple mode too; null when the card has no such fact. */
export function avoidFact(c: Card): string | null {
  switch (avoidKind(c)) {
    case 'price':
      return `Price on ${formatDay(c.raisedFrom!.at)}: ${formatEuro(c.raisedFrom!.priceCents)}`;
    case 'was':
      return `Was price raised from ${formatEuro(c.wasRaisedFromCents!)} to ${formatEuro(c.wasCents!)}`;
    case 'was-high':
      return `Was price ${formatEuro(c.wasCents!)} is above its recent prices`;
    default:
      return null;
  }
}

/** The hanging tag of a judged card; null for none / insufficient (no tag, plain price). */
export function tagProps(c: Card): PriceTagProps | null {
  if (c.verdict === 'good') return { kind: 'good' };
  if (c.verdict !== 'avoid') return null;
  switch (avoidKind(c)) {
    case 'price':
      return { kind: 'avoid', from: c.raisedFrom!.priceCents, to: c.priceCents };
    case 'was':
      return { kind: 'avoid', from: c.wasRaisedFromCents, to: c.wasCents, label: 'WAS RAISED' };
    default:
      return { kind: 'avoid', to: c.priceCents, label: 'AVOID' };
  }
}

/** Price now and the shop's was price (only when above it), or "Price not shown by the shop". */
export function PriceLine({ card, className }: { card: Card; className?: string }) {
  const { priceCents: price, wasCents: was } = card;
  if (price === null) return <p className={cn('text-sm font-medium text-muted-foreground', className)}>{NO_PRICE}</p>;
  return (
    <p className={cn('flex flex-wrap items-baseline gap-x-2', className)}>
      <span className="text-xl font-bold tracking-tight tabular-nums">{formatEuro(price)}</span>
      {was !== null && was > price && (
        <s className="text-sm text-muted-foreground tabular-nums">
          <span className="sr-only">Shop's was price </span>
          {formatEuro(was)}
        </s>
      )}
    </p>
  );
}

/** "Black Friday": the shop marks this product as a Black Friday deal. */
export function BlackFridayMark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex w-fit items-center rounded-full bg-ink px-2 py-0.5 text-xs font-bold text-background', className)}>
      Black Friday
    </span>
  );
}

/** Red banner for a product marked Black Friday whose deal is one to avoid. */
export function AlarmBanner({ card, className }: { card: Card; className?: string }) {
  return (
    <p className={cn('flex items-center gap-1.5 bg-bad px-4 py-1.5 text-sm font-bold text-bad-ink', className)}>
      <TriangleAlert aria-hidden="true" className="size-4 flex-none" />
      {alarmText(card)}
    </p>
  );
}

/**
 * A product on a deal list: tag, title, shop, price and was price. Avoid cards add one fact about
 * the change (Simple too); Advanced adds the verdict sentence. A Black Friday avoid card gets a red
 * border and banner. All shop text is rendered as text.
 */
export function DealCard({ card, className }: { card: Card; className?: string }) {
  const { mode } = useMode();
  const titleId = useId();
  const tag = tagProps(card);
  const avoid = card.verdict === 'avoid';
  const alarm = avoid && card.bf;
  const fact = avoid ? avoidFact(card) : null;

  return (
    <article
      aria-labelledby={titleId}
      data-verdict={card.verdict}
      data-alarm={alarm ? 'true' : undefined}
      className={cn('glass flex h-full min-h-40 flex-col overflow-hidden', alarm && 'border-2 border-bad', className)}
    >
      {alarm && <AlarmBanner card={card} />}
      <div className={cn('relative flex flex-1 flex-col gap-1.5 p-4', tag && 'pr-24')}>
        {tag && (
          <div className="absolute top-2 right-4">
            <PriceTag {...tag} />
          </div>
        )}
        <p className="relative z-10 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <ShopBadge name={card.shop} size="sm" />
          <Link
            to={`/shops/${encodeURIComponent(card.shopSlug)}`}
            className="truncate rounded-sm outline-none hover:text-ink hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {card.shop}
          </Link>
        </p>
        <h3 id={titleId} className="line-clamp-2 text-[15px] leading-snug font-semibold">
          {/* the title link covers the card, so the whole card opens the product */}
          <Link
            to={listingPath(card.id)}
            className="rounded-sm outline-none after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {card.title}
          </Link>
        </h3>
        <PriceLine card={card} className="mt-auto pt-1" />
        {card.bf && !alarm && <BlackFridayMark />}
        {fact && <p className="text-sm font-semibold text-bad">{fact}</p>}
        {mode === 'advanced' && card.reason && <p className="text-sm text-muted-foreground">{card.reason}</p>}
      </div>
    </article>
  );
}
