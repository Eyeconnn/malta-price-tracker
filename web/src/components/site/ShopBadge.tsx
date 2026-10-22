import { useState } from 'react';
import { cn } from '@/lib/utils';

/** Two letters for a shop with no logo: first letters of the first two words, or the first two letters. */
export function initials(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return '?';
  const [first, second] = words.map((w) => [...w]);
  return (second ? first![0]! + second[0]! : first!.slice(0, 2).join('')).toUpperCase();
}

export type ShopBadgeProps = { name: string; logoUrl?: string | null; size?: 'sm' | 'md'; className?: string };

/** The shop's logo in a circle, or its initials when there is no logo or it fails to load. */
export function ShopBadge({ name, logoUrl, size = 'md', className }: ShopBadgeProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showLogo = !!logoUrl && failedUrl !== logoUrl;
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        'inline-grid flex-none place-items-center overflow-hidden rounded-full font-extrabold shadow-[0_0_0_2px_var(--glass),0_4px_10px_-4px_rgba(0,0,0,0.4)]',
        size === 'sm' ? 'size-7 text-[10px]' : 'size-[38px] text-[13px]',
        showLogo ? 'bg-popover' : 'bg-primary text-primary-foreground',
        className,
      )}
    >
      {showLogo ? (
        <img src={logoUrl} alt="" className="size-full object-cover" loading="lazy" onError={() => setFailedUrl(logoUrl)} />
      ) : (
        initials(name)
      )}
    </span>
  );
}
