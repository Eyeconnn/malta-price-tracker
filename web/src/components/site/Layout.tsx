import { Search } from 'lucide-react';
import { Outlet, useLocation } from 'react-router';
import { Background, GlassFilters } from '@/components/site/Background';
import { BottomNav } from '@/components/site/BottomNav';
import { SearchOverlayProvider, useSearchOverlay } from '@/components/site/SearchOverlay';
import { SiteLogo } from '@/components/site/SiteLogo';
import { TopNav } from '@/components/site/TopNav';
import { DESKTOP_QUERY } from '@/components/site/nav';
import { usePageTransition } from '@/lib/usePageTransition';
import { useMediaQuery } from '@/lib/useMediaQuery';

/** Phone top bar: slim smoked glass with the brand and a search button (opens the search overlay). */
function PhoneHeader() {
  const { open, openSearch } = useSearchOverlay();
  return (
    <header className="smoke sticky top-0 z-40 flex min-h-14 items-center justify-between py-1.5 pr-3 pl-4 md:hidden">
      <SiteLogo />
      <button
        type="button"
        aria-label="Search"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => openSearch(e.currentTarget)}
        className="inline-flex size-11 items-center justify-center rounded-full border border-white/14 bg-white/6 text-white outline-none hover:bg-white/10 focus-visible:ring-[3px] focus-visible:ring-white/70"
      >
        <Search aria-hidden="true" className="size-[18px]" />
      </button>
    </header>
  );
}

/** The page column: its direct children are the page's blocks, which slide in and out on a page change. */
function Page() {
  const phase = usePageTransition();
  const { pathname } = useLocation();
  return (
    <div
      key={pathname}
      data-phase={phase ?? undefined}
      className="page mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-4 pt-[18px] pb-[calc(7.5rem+env(safe-area-inset-bottom))] [--stack-gap:20px] md:gap-6 md:px-6 md:pt-7 md:pb-[72px] md:[--stack-gap:24px]"
    >
      <Outlet />
    </div>
  );
}

/**
 * Page frame: the smoked top bar from 768px and wider, the slim phone header and floating bottom bar below it.
 * Only one set is mounted (useMediaQuery); each also hides itself with CSS classes. The layout renders no h1:
 * every page brings its own.
 */
export function Layout() {
  const desktop = useMediaQuery(DESKTOP_QUERY, true);
  return (
    <SearchOverlayProvider>
      <Background />
      <GlassFilters />
      <a
        href="#main"
        onClick={(e) => {
          // a plain #hash link would add a history entry the router does not know about
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
        className="glass sr-only z-50 min-h-11 items-center px-4 text-ink focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:inline-flex"
      >
        Skip to content
      </a>
      {desktop ? <TopNav /> : <PhoneHeader />}
      <main id="main" tabIndex={-1} className="outline-none">
        <Page />
      </main>
      {!desktop && <BottomNav />}
    </SearchOverlayProvider>
  );
}
