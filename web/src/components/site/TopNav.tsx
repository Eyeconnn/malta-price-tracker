import { Search } from 'lucide-react';
import { NavLink, useLocation } from 'react-router';
import { ModeSwitch, ThemeChoice } from '@/components/site/Preferences';
import { SiteLogo } from '@/components/site/SiteLogo';
import { useSearchOverlay } from '@/components/site/SearchOverlay';
import { HOW_WE_CHECK, MAIN_LINKS } from '@/components/site/nav';
import { cn } from '@/lib/utils';

const link = ({ isActive }: { isActive: boolean }) =>
  cn(
    'inline-flex min-h-11 items-center rounded-md border-b-2 px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
    isActive ? 'border-brand font-semibold text-ink' : 'border-transparent text-muted-foreground hover:text-ink',
  );

/** Desktop navigation (768px and wider): logo, the search button, page links, and the mode and theme controls. */
export function TopNav() {
  const { open, openSearch } = useSearchOverlay();
  const onSearchPage = useLocation().pathname === '/search';
  return (
    <header className="sticky top-0 z-40 hidden border-b border-line bg-bar backdrop-blur-md md:block">
      <nav aria-label="Main navigation" className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-2">
        <SiteLogo />
        <div className="ml-3 flex items-center gap-1">
          <button
            type="button"
            aria-label="Search"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={(e) => openSearch(e.currentTarget)}
            className={cn(
              'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border-b-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              onSearchPage ? 'border-brand text-ink' : 'border-transparent text-muted-foreground hover:text-ink',
            )}
          >
            <Search aria-hidden="true" className="size-5" />
          </button>
          {[...MAIN_LINKS, HOW_WE_CHECK].map(({ to, label }) => (
            <NavLink key={to} to={to} className={link}>
              {label}
            </NavLink>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-4">
          <ModeSwitch />
          <ThemeChoice className="w-auto" />
        </div>
      </nav>
    </header>
  );
}
