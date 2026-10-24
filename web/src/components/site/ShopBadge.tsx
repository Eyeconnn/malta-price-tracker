import { useState } from 'react';
import { cn } from '@/lib/utils';

/** Two letters for a shop with no logo: first letters of the first two words, or the first two letters. */
export function initials(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return '?';
  const [first, second] = words.map((w) => [...w]);
  return (second ? first![0]! + second[0]! : first!.slice(0, 2).join('')).toUpperCase();
}

/** A logo wider than this (width / height) is drawn as a pill; up to it, as a circle. */
export const PILL_ASPECT = 1.4;
/** A pill is at most this many times as wide as it is tall. */
const MAX_PILL_ASPECT = 4;

/**
 * logoUrl: our own copy of the shop's logo (/img/<sha256>.webp from the API), never a shop's address.
 * logoAspect: that copy's width / height (null when unknown): a wide wordmark is drawn as a pill, not a circle.
 * decorative: the shop's name is shown next to the badge, so the badge is hidden from screen readers.
 */
export type ShopBadgeProps = {
  name: string;
  logoUrl?: string | null;
  logoAspect?: number | null;
  size?: 'sm' | 'md';
  decorative?: boolean;
  className?: string;
};

/**
 * The shop's logo contained on white, as logos are drawn for: in a circle, or in a pill of the same height when the
 * logo is wide; its initials in a circle when there is no logo or it fails to load.
 */
export function ShopBadge({ name, logoUrl, logoAspect, size = 'md', decorative = false, className }: ShopBadgeProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showLogo = !!logoUrl && failedUrl !== logoUrl;
  const px = size === 'sm' ? 28 : 38;
  const pill = showLogo && typeof logoAspect === 'number' && Number.isFinite(logoAspect) && logoAspect > PILL_ASPECT;
  const width = pill ? Math.round(px * Math.min(logoAspect!, MAX_PILL_ASPECT)) : px;
  // the logo image carries the name itself; the initials need the badge to carry it
  const label = decorative ? { 'aria-hidden': true } : showLogo ? {} : { role: 'img', 'aria-label': name };
  return (
    <span
      {...label}
      data-shape={pill ? 'pill' : 'circle'}
      style={pill ? { width: `${width}px` } : undefined}
      className={cn(
        'inline-grid flex-none place-items-center overflow-hidden rounded-full font-extrabold shadow-[0_0_0_2px_var(--glass),0_4px_10px_-4px_rgba(0,0,0,0.4)]',
        pill ? (size === 'sm' ? 'h-7 px-1.5' : 'h-[38px] px-2') : size === 'sm' ? 'size-7 text-[10px]' : 'size-[38px] text-[13px]',
        showLogo ? (pill ? 'bg-white py-[3px]' : 'bg-white p-[3px]') : 'bg-primary text-primary-foreground',
        className,
      )}
    >
      {showLogo ? (
        <img
          src={logoUrl}
          alt={decorative ? '' : name}
          width={width}
          height={px}
          loading="lazy"
          decoding="async"
          className={cn('size-full object-contain', !pill && 'rounded-full')}
          onError={() => setFailedUrl(logoUrl)}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
