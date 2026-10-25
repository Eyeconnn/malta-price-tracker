import { TrendingUp, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Chip } from '@/components/site/Chip';
import { useMode } from '@/components/site/ModeProvider';
import type { PriceTagProps } from '@/components/site/PriceTag';
import { ShopBadge } from '@/components/site/ShopBadge';
import { buttonVariants } from '@/components/ui/button';
import type { Card } from '@/lib/api';
import { formatDay, formatEuro } from '@/lib/format';
import { listingPath } from '@/lib/links';
import { productIcon } from '@/lib/productIcon';
import { cn } from '@/lib/utils';
import { wasTerms } from '../../../../src/site/verdict.js';

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

/** What an avoid card is about, in lower case; the reference price goes by the shop's own term (wasLabel) when it has one. */
function avoidWhat(c: Card): string {
  const was = wasTerms(c.wasLabel).inner;
  switch (avoidKind(c)) {
    case 'price':
      return 'price raised';
    case 'was':
      return `${was} raised`;
    case 'was-high':
      return `${was} above its recent prices`;
    default:
      return 'deal to avoid';
  }
}

/** What an avoid card is about, as a short label: "Price raised", "Was price raised", ... */
export function avoidSummary(c: Card): string {
  const what = avoidWhat(c);
  return what.charAt(0).toUpperCase() + what.slice(1);
}

/** The line of a Black Friday avoid listing, e.g. "Marked Black Friday, price raised". */
export function alarmText(c: Card): string {
  return `Marked Black Friday, ${avoidWhat(c)}`;
}

/** One short fact about what changed; null when the card has no such fact. */
export function avoidFact(c: Card): string | null {
  switch (avoidKind(c)) {
    case 'price':
      return `Price on ${formatDay(c.raisedFrom!.at)}: ${formatEuro(c.raisedFrom!.priceCents)}`;
    case 'was':
      return `${wasTerms(c.wasLabel).start} raised from ${formatEuro(c.wasRaisedFromCents!)} to ${formatEuro(c.wasCents!)}`;
    case 'was-high':
      return `${wasTerms(c.wasLabel).start} ${formatEuro(c.wasCents!)} is above its recent prices`;
    default:
      return null;
  }
}

/** The hanging tag of a judged listing; null for none / insufficient (no tag, plain price). */
export function tagProps(c: Card): PriceTagProps | null {
  if (c.verdict === 'good') return { kind: 'good' };
  if (c.verdict !== 'avoid') return null;
  switch (avoidKind(c)) {
    case 'price':
      return { kind: 'avoid', from: c.raisedFrom!.priceCents, to: c.priceCents };
    case 'was':
      // the shop's own term when it has one ("LIST PRICE RAISED"), else the short "WAS RAISED"
      return { kind: 'avoid', from: c.wasRaisedFromCents, to: c.wasCents, label: c.wasLabel ? `${wasTerms(c.wasLabel).start.toUpperCase()} RAISED` : 'WAS RAISED' };
    default:
      return { kind: 'avoid', to: c.priceCents, label: 'AVOID' };
  }
}

/** The discount the shop claims, in whole percent: its was price against the price; 0 when it claims none. */
export function claimedPct(c: Pick<Card, 'priceCents' | 'wasCents'>): number {
  const { priceCents: p, wasCents: w } = c;
  return p !== null && w !== null && w > p && p > 0 ? Math.round(((w - p) / w) * 100) : 0;
}

/**
 * The card's honest badge, from the verdict: "20% off, real deal", "Price raised", "Was price raised" (the shop's
 * own term when it has one) or "Discount not real". null for a card that is not judged.
 */
export function dealBadge(c: Card): string | null {
  if (c.verdict === 'good') {
    const pct = claimedPct(c);
    return pct > 0 ? `${pct}% off, real deal` : 'Real deal';
  }
  if (c.verdict !== 'avoid') return null;
  switch (avoidKind(c)) {
    case 'price':
      return 'Price raised';
    case 'was':
      return `${wasTerms(c.wasLabel).start} raised`;
    case 'was-high':
      return 'Discount not real';
    default:
      return 'Deal to avoid';
  }
}

/**
 * Price now and the shop's was price (only when above it), or "Price not shown by the shop". A shop with its own term
 * for the reference price (wasLabel, e.g. "List price") gets that term shown before it.
 */
export function PriceLine({ card, className, priceClassName }: { card: Card; className?: string; priceClassName?: string }) {
  const { priceCents: price, wasCents: was } = card;
  if (price === null) return <p className={cn('text-sm font-medium text-muted-foreground', className)}>{NO_PRICE}</p>;
  return (
    <p className={cn('flex flex-wrap items-baseline gap-x-2', className)}>
      <span className={cn('t-num text-[22px]', priceClassName)}>{formatEuro(price)}</span>
      {was !== null && was > price && card.wasLabel && <span className="text-sm text-muted-foreground">{card.wasLabel}</span>}
      {was !== null && was > price && (
        <s className="text-[15px] text-faint tabular-nums">
          {!card.wasLabel && <span className="sr-only">Shop's was price </span>}
          {formatEuro(was)}
        </s>
      )}
    </p>
  );
}

/** "Black Friday": the shop marks this product as a Black Friday deal. */
export function BlackFridayMark({ className }: { className?: string }) {
  return (
    <Chip tone="bf" className={className}>
      Black Friday
    </Chip>
  );
}

/** A calm line for a product marked Black Friday whose deal is one to avoid. */
export function AlarmBanner({ card, className }: { card: Card; className?: string }) {
  return (
    <p className={cn('flex items-center gap-1.5 text-sm font-semibold text-bad', className)}>
      <TriangleAlert aria-hidden="true" className="size-4 flex-none" />
      {alarmText(card)}
    </p>
  );
}

const HOVERLESS = '(hover: none)';
const hoverless = () => {
  try {
    return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(HOVERLESS).matches;
  } catch {
    return false;
  }
};

/**
 * A deal as a product reveal card: a product icon with an honest badge and the Black Friday chip, the shop, name
 * and price. Pointing at it or focusing it lifts it and slides up a panel with one line of why, the shop's claim
 * against our check, and "See price history" and the shop's rating. On a touch screen the card opens by itself
 * while it sits in the middle of the screen, and a tap on it (not on a link) opens or closes it. All shop text is
 * rendered as text.
 */
export function DealCard({ card, className }: { card: Card; className?: string }) {
  const { mode } = useMode();
  const titleId = useId();
  const root = useRef<HTMLElement>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const [touch] = useState(hoverless);
  const avoid = card.verdict === 'avoid';
  const good = card.verdict === 'good';
  const judged = good || avoid;
  const badge = dealBadge(card);
  const claimed = claimedPct(card);
  const Icon = productIcon(card.title, card.category);
  const active = hover || focus || touchOpen;
  const why = mode === 'advanced' || !avoid ? (card.reason ?? avoidFact(card)) : (avoidFact(card) ?? card.reason);

  // phones have no hover: the card opens while it sits in the middle band of the screen
  useEffect(() => {
    const el = root.current;
    if (!touch || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => setTouchOpen(!!entries[0]?.isIntersecting), { rootMargin: '-42% 0px -42% 0px', threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [touch]);

  return (
    <article
      ref={root}
      aria-labelledby={titleId}
      data-verdict={card.verdict}
      data-alarm={avoid && card.bf ? 'true' : undefined}
      data-active={active ? 'true' : undefined}
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
      }}
      onClick={(e) => {
        // a tap on the card itself (not on its links or buttons) opens or closes it on a touch screen
        if (!touch || (e.target instanceof Element && e.target.closest('a, button'))) return;
        setTouchOpen((o) => !o);
      }}
      className={cn('prc glass-card relative flex h-full min-h-[360px] flex-col overflow-hidden', className)}
    >
      <div className="relative h-[188px] flex-none overflow-hidden border-b border-line">
        <div aria-hidden="true" className="prc-img absolute inset-0 flex items-center justify-center text-faint">
          <Icon className="size-14" strokeWidth={1.4} />
        </div>
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-linear-to-t from-black/25 to-transparent to-55%" />
        {badge && (
          <span
            className={cn(
              'prc-badge absolute top-3.5 left-3.5 rounded-full px-[11px] py-[5px] text-xs font-bold',
              good ? 'bg-good-fill text-good-fill-ink' : 'bg-bad-fill text-bad-ink',
            )}
          >
            {badge}
          </span>
        )}
        {card.bf && <BlackFridayMark className="absolute bottom-3 left-3.5" />}
      </div>

      <div className="flex flex-1 flex-col gap-2 px-5 pt-[18px] pb-5">
        <p className="relative z-[1] flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
          <ShopBadge name={card.shop} logoUrl={card.logoUrl} logoAspect={card.logoAspect} size="sm" decorative />
          <Link
            to={`/shops/${encodeURIComponent(card.shopSlug)}`}
            className="truncate rounded-sm text-muted-foreground outline-none hover:text-ink hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {card.shop}
          </Link>
        </p>
        <h3 id={titleId} className="line-clamp-2 text-[17px] leading-snug font-bold tracking-[-0.01em]">
          {/* the title link covers the card, so a click anywhere opens the product */}
          <Link to={listingPath(card.id)} className="rounded-sm text-ink outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {card.title}
          </Link>
        </h3>
        <PriceLine card={card} className="mt-auto pt-0.5" priceClassName="text-[26px] text-brand" />
      </div>

      <div aria-hidden={active ? undefined : true} inert={!active} className="prc-overlay absolute inset-0 z-[3] flex flex-col justify-end">
        <div className="flex flex-col gap-3.5 p-5">
          <div className="prc-step">
            <h4 className="mb-1.5 text-[15px] font-bold">{good ? 'Why it is a good deal' : avoid ? 'Why to avoid it' : 'Not judged yet'}</h4>
            {why && <p className="text-[13.5px] leading-normal text-muted-foreground">{why}</p>}
          </div>
          {judged && (
            <div className="prc-step grid grid-cols-2 gap-2.5">
              <div className="rounded-[10px] bg-fill px-2 py-[9px] text-center text-[13px]">
                <div className="font-bold">{claimed > 0 ? `${claimed}% off` : 'No discount'}</div>
                <div className="text-muted-foreground">Shop's claim</div>
              </div>
              <div className="rounded-[10px] bg-fill px-2 py-[9px] text-center text-[13px]">
                <div className={cn('font-bold', good ? 'text-good' : 'text-bad')}>{good ? 'Real deal' : 'Not real'}</div>
                <div className="text-muted-foreground">Our check</div>
              </div>
            </div>
          )}
          <div className="prc-step flex flex-col gap-2.5">
            <Link to={listingPath(card.id)} tabIndex={active ? undefined : -1} className={cn(buttonVariants(), 'prc-btn min-h-12 w-full')}>
              <TrendingUp aria-hidden="true" />
              See price history
            </Link>
            <Link
              to={`/shops/${encodeURIComponent(card.shopSlug)}`}
              tabIndex={active ? undefined : -1}
              className={cn(buttonVariants({ variant: 'outline' }), 'prc-btn w-full')}
            >
              {`${card.shop} rating`}
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
