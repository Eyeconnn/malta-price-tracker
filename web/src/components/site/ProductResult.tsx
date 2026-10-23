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

/** The visible title: "Samsung Galaxy S25 Ultra Smartphone · 256GB", and " · Grey" for a one-listing option. */
export const resultTitle = (r: Pick<ProductResult, 'name' | 'specs' | 'option'>) => withSpecs(withSpecs(r.name, r.specs), r.option);

/** The title as a screen reader hears it: the specs and option after commas, not middle dots. */
const spokenTitle = (r: Pick<ProductResult, 'name' | 'specs' | 'option'>) => [r.name, r.specs, r.option].filter((x) => x).join(', ');

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

/** Our own stored photo copies only (the API gives /img/<sha256>.webp): the browser never contacts a shop. */
const PHOTO = /^\/img\/[0-9a-f]{64}\.webp$/;

/**
 * A product photo, our own small copy (at most 480 px). width and height keep its square box (object-contain)
 * so nothing moves when it loads; loaded lazily, decoded off the main thread. alt: the clean product name, or ""
 * where that name is shown right next to the image (so it is not read twice). Without a photo (or when it does not
 * load) a neutral placeholder of the same size.
 */
export function ProductImage({ url, alt, size, className }: { url: string | null; alt: string; size: number; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || !PHOTO.test(url) || failed === url) {
    return <span aria-hidden="true" data-photo-placeholder="" className={cn('block flex-none rounded-xl bg-secondary/60', className)} style={{ width: size, height: size }} />;
  }
  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(url)}
      className={cn('flex-none rounded-xl bg-popover object-contain', className)}
    />
  );
}
