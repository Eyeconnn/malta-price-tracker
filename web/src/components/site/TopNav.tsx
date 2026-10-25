import { NavLink, useLocation } from 'react-router';
import { ModeChoice, ThemeButton } from '@/components/site/Preferences';
import { useSearchOverlay } from '@/components/site/SearchOverlay';
import { SiteLogo } from '@/components/site/SiteLogo';
import { HOW_WE_CHECK, isSearchPage, MAIN_LINKS } from '@/components/site/nav';
import { cn } from '@/lib/utils';

/** One page link in the bar: the same width and height as the others, a short accent underline when current. */
export const navItem = (on: boolean) =>
  cn(
    'relative inline-flex h-[42px] min-w-24 items-center justify-center rounded-full px-4 text-sm font-semibold whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-white/70',
    on
      ? "text-white after:absolute after:inset-x-6 after:bottom-[3px] after:h-[3px] after:rounded-t-[3px] after:bg-[var(--accent-soft)] after:content-['']"
      : 'text-white-muted hover:bg-white/10 hover:text-white',
  );

/**
 * Desktop navigation (768px and wider) on smoked glass: the brand left, the page links centred, the
 * Simple/Advanced control and the theme button right. Every control is 42px tall. Search opens the search overlay.
 */
export function TopNav() {
  const { open, openSearch } = useSearchOverlay();
  const searchOn = isSearchPage(useLocation().pathname);
  return (
    <header className="smoke sticky top-0 z-40 hidden shadow-[inset_0_-1px_0_rgba(255,255,255,0.08),0_12px_30px_-20px_rgba(27,26,25,0.6)] md:block">
      <div className="mx-auto grid min-h-16 max-w-[1440px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-6 px-6 py-2">
        <div className="justify-self-start">
          <SiteLogo />
        </div>
        <nav aria-label="Main navigation" className="flex items-center gap-1.5 justify-self-center">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-current={searchOn ? 'page' : undefined}
            onClick={(e) => openSearch(e.currentTarget)}
            className={navItem(searchOn)}
          >
            Search
          </button>
          {[...MAIN_LINKS, HOW_WE_CHECK].map(({ to, label }) => (
            <NavLink key={to} to={to} className={({ isActive }) => navItem(isActive)}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2 justify-self-end">
          <ModeChoice />
          <ThemeButton />
        </div>
      </div>
    </header>
  );
}
