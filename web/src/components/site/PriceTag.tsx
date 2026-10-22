import { formatEuro } from '@/lib/format';
import { cn } from '@/lib/utils';

export type PriceTagProps = {
  kind: 'good' | 'avoid';
  /** cents: the earlier, lower price (avoid tags show it crossed out); shown only with a valid `to` */
  from?: number | null;
  /** cents: the price now */
  to?: number | null;
  /** replaces the words "REAL DEAL" (good) or "RAISED" (avoid) */
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
};

// The tag outline from the approved mockup, in a 78 x 104 box: pointed top, rounded bottom corners.
const TAG_PATH = 'M8 22 L39 2 L70 22 L70 96 A6 6 0 0 1 64 102 L14 102 A6 6 0 0 1 8 96 Z';

// Sparkle positions around a good tag, from the mockup.
const SPARKLES = [
  { left: '-12%', top: '30%', delay: '0s', small: false },
  { right: '-10%', top: '62%', delay: '0.8s', small: false },
  { left: '12%', top: '86%', delay: '1.5s', small: true },
] as const;

/** A price worth showing: a positive, finite number of cents. Zero, negative or missing never shows as "€0.00". */
function priceText(cents: number | null | undefined): string | null {
  return typeof cents === 'number' && Number.isFinite(cents) && cents > 0 ? formatEuro(cents) : null;
}

function spoken(kind: PriceTagProps['kind'], from: string | null, to: string | null, label: string | undefined): string {
  const range = from && to ? `from ${from} to ${to}` : to ? `now ${to}` : null;
  if (label) return range ? `${label}: ${range}` : label;
  if (kind === 'avoid') return from && to ? `Raised ${range}` : to ? `Raised, ${range}` : 'Raised';
  return from && to ? `Real deal: down ${range}` : to ? `Real deal: ${range}` : 'Real deal';
}

/**
 * The hanging price tag: a gold tag that swings and twinkles for a real deal, a red tag hanging
 * crooked with the earlier price crossed out above the raised one for a deal to avoid.
 * Screen readers get one sentence with the facts; the drawing itself is hidden from them.
 */
export function PriceTag({ kind, from, to, label, size = 'md', className }: PriceTagProps) {
  // Without a valid price now, an earlier price alone means nothing: show neither.
  const toText = priceText(to);
  const fromText = toText ? priceText(from) : null;
  const long = Math.max(fromText?.length ?? 0, toText?.length ?? 0) > 7;
  const w = size === 'sm' ? 50 : 66;
  const h = size === 'sm' ? 67 : 88;

  return (
    <div
      role="img"
      aria-label={spoken(kind, fromText, toText, label)}
      data-kind={kind}
      className={cn('price-tag', `price-tag-${kind}`, size === 'sm' && 'price-tag-sm', long && 'price-tag-long', className)}
    >
      <svg aria-hidden="true" width={w} height={h} viewBox="0 0 78 104">
        <line className="price-tag-string" x1="39" y1="-30" x2="39" y2="12" strokeWidth="1.4" />
        <path className="price-tag-body" d={TAG_PATH} strokeWidth="1.5" />
        <circle className="price-tag-hole" cx="39" cy="18" r="4" />
      </svg>
      <div aria-hidden="true" className="price-tag-label">
        {kind === 'avoid' ? (
          <>
            {fromText && (
              <>
                <s>{fromText}</s>
                <br />
              </>
            )}
            {toText && (
              <>
                {toText}
                <br />
              </>
            )}
            <small>{label ?? 'RAISED'}</small>
          </>
        ) : label ? (
          label
        ) : (
          <>
            REAL
            <br />
            DEAL
          </>
        )}
      </div>
      {kind === 'good' &&
        SPARKLES.map(({ delay, small, ...pos }, i) => (
          <span
            key={i}
            aria-hidden="true"
            data-sparkle=""
            className={cn('price-tag-sparkle', small && 'price-tag-sparkle-small')}
            style={{ ...pos, animationDelay: delay }}
          >
            {'\u2726'}
          </span>
        ))}
    </div>
  );
}
