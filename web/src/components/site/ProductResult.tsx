// One search result is one product (design Part 3): what the Search page's cards and the live results under a
// search box say about it. All shop text is rendered as text.
import { useState } from 'react';
import { NO_PRICE } from '@/components/site/DealCard';
import type { ProductResult } from '@/lib/api';
import { formatEuro } from '@/lib/format';
import { cn } from '@/lib/utils';
import { withSpecs } from '../../../../src/site/display.js';

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** The link to a product's page. */
export const productPath = (key: string) => `/product/${encodeURIComponent(key)}`;

/** The visible title: "Samsung Galaxy S25 Ultra Smartphone · 256GB". */
export const resultTitle = (r: Pick<ProductResult, 'name' | 'specs'>) => withSpecs(r.name, r.specs);

/** The title as a screen reader hears it: the specs after a comma, not a middle dot. */
const spokenTitle = (r: Pick<ProductResult, 'name' | 'specs'>) => (r.specs ? `${r.name}, ${r.specs}` : r.name);

/** "€719.00", or "Price not shown by the shop" (never €0.00). */
export const resultPrice = (r: ProductResult) => (positive(r.priceCents) ? formatEuro(r.priceCents) : NO_PRICE);

const shopsText = (n: number) => `${n} ${n === 1 ? 'shop' : 'shops'}`;

/**
 * The name of a result's link: "<title> at <shop>, <price>" for one shop, "<title>, from <price> at <N> shops"
 * for several (the lowest price).
 */
export function resultLabel(r: ProductResult): string {
  const title = spokenTitle(r);
  if (r.shops > 1) return positive(r.priceCents) ? `${title}, from ${formatEuro(r.priceCents)} at ${r.shops} shops` : `${title}, ${NO_PRICE} at ${r.shops} shops`;
  return `${title} at ${r.shop ?? shopsText(1)}, ${resultPrice(r)}`;
}

/** "at AtoZ" or "from €1,199.00 at 3 shops" (the visible line under the title). */
export function sellersLine(r: ProductResult): string {
  if (r.shops > 1) return positive(r.priceCents) ? `from ${formatEuro(r.priceCents)} at ${r.shops} shops` : `at ${r.shops} shops`;
  return `at ${r.shop ?? shopsText(1)}`;
}

/**
 * The verdicts of a result, per seller (a was price is one shop's claim, so there is no one product verdict):
 * "Deal to avoid" / "Real deal" for one shop, "Deal to avoid at 2 shops" for several.
 */
export function verdictParts(r: ProductResult): { tone: 'bad' | 'good'; text: string }[] {
  const at = (n: number) => (r.shops > 1 ? ` at ${shopsText(n)}` : '');
  const out: { tone: 'bad' | 'good'; text: string }[] = [];
  if (r.avoid > 0) out.push({ tone: 'bad', text: `Deal to avoid${at(r.avoid)}` });
  if (r.good > 0) out.push({ tone: 'good', text: `Real deal${at(r.good)}` });
  return out;
}

/** The verdicts and the Black Friday marker as one sentence (a link's description); empty when there is nothing. */
export function verdictNote(r: ProductResult): string {
  return [...verdictParts(r).map((p) => p.text), ...(r.bf ? ['Black Friday'] : [])].join(', ');
}

/**
 * A product picture from a shop (http(s) only, checked by the API); hidden when it does not load. Decorative:
 * the product's name is always next to it.
 */
export function ProductImage({ url, className }: { url: string | null; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) return null;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(url)}
      className={cn('flex-none rounded-xl bg-popover object-contain', className)}
    />
  );
}
