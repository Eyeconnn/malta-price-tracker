import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { ShopBadge } from '@/components/site/ShopBadge';
import type { OtherShop } from '@/lib/api';
import { formatEuro } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * "Cheaper at <shop>, €X": the server's `cheaper` match (exact match, in stock, at least cheaperPct
 * cheaper), linking to that shop's product page. `ownCents` is this product's price, for "€Y less".
 * Renders nothing without a positive price at the other shop.
 */
export function CheaperBox({ cheaper, ownCents, className }: { cheaper: OtherShop; ownCents: number | null; className?: string }) {
  const price = cheaper.priceCents;
  if (price === null || !(price > 0)) return null;
  const less = ownCents !== null && ownCents > price ? ownCents - price : null;
  return (
    <Link
      to={`/p/${cheaper.id}`}
      className={cn(
        // glass, not a green tint: green text on a green tint is below 4.5:1 (test/web/contrast.test.ts)
        'group glass flex items-center gap-3 border-2 border-good px-4 py-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className,
      )}
    >
      <ShopBadge name={cheaper.shop} size="sm" />
      <span className="flex min-w-0 flex-col">
        <span className="font-bold group-hover:underline break-words text-ink">
          Cheaper at {cheaper.shop}, <span className="text-good tabular-nums">{formatEuro(price)}</span>
        </span>
        <span className="text-sm text-muted-foreground">
          Same product at another shop{less !== null && `, ${formatEuro(less)} less than here`}
          {cheaper.inStock === true && ', in stock'}
        </span>
      </span>
      <ArrowRight aria-hidden="true" className="ml-auto size-5 flex-none text-good" />
    </Link>
  );
}
