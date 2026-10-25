import { Ellipsis, Search, Store, Tag } from 'lucide-react';
import { NavLink, useLocation } from 'react-router';
import { MoreSheet } from '@/components/site/MoreSheet';
import { useSearchOverlay } from '@/components/site/SearchOverlay';
import { isSearchPage, MAIN_LINKS } from '@/components/site/nav';
import { cn } from '@/lib/utils';

const ICONS = { '/deals': Tag, '/shops': Store } as const;

const item = (on: boolean) =>
  cn(
    'flex min-h-[54px] w-full flex-col items-center justify-center gap-1 rounded-2xl text-[11.5px] leading-tight font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-white/70',
    on ? 'bg-white/12 text-white' : 'text-white-muted',
  );

/**
 * Phone navigation (below 768px): a floating smoked-glass bar with four equal items, Search (opens the search
 * overlay), Deals, Shops and More.
 */
export function BottomNav() {
  const { open, openSearch } = useSearchOverlay();
  const searchOn = isSearchPage(useLocation().pathname);
  return (
    <nav
      aria-label="Mobile navigation"
      className="smoke fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-40 grid grid-cols-4 gap-1 rounded-[22px] p-1.5 shadow-[0_14px_30px_-12px_rgba(0,0,0,0.5)] md:hidden"
    >
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-current={searchOn ? 'page' : undefined}
        onClick={(e) => openSearch(e.currentTarget)}
        className={item(searchOn)}
      >
        <Search aria-hidden="true" className="size-5" />
        Search
      </button>
      {MAIN_LINKS.map(({ to, label }) => {
        const Icon = ICONS[to];
        return (
          <NavLink key={to} to={to} className={({ isActive }) => item(isActive)}>
            <Icon aria-hidden="true" className="size-5" />
            {label}
          </NavLink>
        );
      })}
      <MoreSheet
        trigger={
          <button type="button" className={item(false)}>
            <Ellipsis aria-hidden="true" className="size-5" />
            More
          </button>
        }
      />
    </nav>
  );
}
