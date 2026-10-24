import { useState } from 'react';
import { cn } from '@/lib/utils';

/** Two letters for a shop with no logo: first letters of the first two words, or the first two letters. */
export function initials(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return '?';
  const [first, second] = words.map((w) => [...w]);
  return (second ? first![0]! + second[0]! : first!.slice(0, 2).join('')).toUpperCase();
}

/**
 * logoUrl: our own copy of the shop's logo (/img/<sha256>.webp from the API), never a shop's address.
 * decorative: the shop's name is shown next to the badge, so the badge is hidden from screen readers.
 */
export type ShopBadgeProps = { name: string; logoUrl?: string | null; size?: 'sm' | 'md'; decorative?: boolean; className?: string };

/** The shop's logo in a circle (contained on white, as logos are drawn for), or its initials when there is none or it fails to load. */
export function ShopBadge({ name, logoUrl, size = 'md', decorative = false, className }: ShopBadgeProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showLogo = !!logoUrl && failedUrl !== logoUrl;
  const px = size === 'sm' ? 28 : 38;
  // the logo image carries the name itself; the initials need the circle to carry it
  const label = decorative ? { 'aria-hidden': true } : showLogo ? {} : { role: 'img', 'aria-label': name };
  return (
    <span
      {...label}
      className={cn(
        'inline-grid flex-none place-items-center overflow-hidden rounded-full font-extrabold shadow-[0_0_0_2px_var(--glass),0_4px_10px_-4px_rgba(0,0,0,0.4)]',
        size === 'sm' ? 'size-7 text-[10px]' : 'size-[38px] text-[13px]',
        showLogo ? 'bg-white p-[3px]' : 'bg-primary text-primary-foreground',
        className,
      )}
    >
      {showLogo ? (
        <img
          src={logoUrl}
          alt={decorative ? '' : name}
          width={px}
          height={px}
          loading="lazy"
          decoding="async"
          className="size-full rounded-full object-contain"
          onError={() => setFailedUrl(logoUrl)}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
