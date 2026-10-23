import { Outlet } from 'react-router';
import { Background } from '@/components/site/Background';
import { BottomNav } from '@/components/site/BottomNav';
import { SearchOverlayProvider } from '@/components/site/SearchOverlay';
import { SiteLogo } from '@/components/site/SiteLogo';
import { TopNav } from '@/components/site/TopNav';
import { DESKTOP_QUERY } from '@/components/site/nav';
import { useMediaQuery } from '@/lib/useMediaQuery';

/**
 * Page frame: the top nav from 768px and wider, the floating bottom bar below it. Only one of them
 * is mounted (useMediaQuery); each also hides itself with CSS classes. The layout renders no h1:
 * every page brings its own.
 */
export function Layout() {
  const desktop = useMediaQuery(DESKTOP_QUERY, true);
  return (
    <SearchOverlayProvider>
      <Background />
      <a
        href="#main"
        onClick={(e) => {
          // a plain #hash link would add a history entry the router does not know about
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
        className="glass sr-only z-50 min-h-11 items-center px-4 focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:inline-flex"
      >
        Skip to content
      </a>
      {desktop ? (
        <TopNav />
      ) : (
        <header className="px-4 pt-2 md:hidden">
          <SiteLogo />
        </header>
      )}
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto max-w-5xl px-4 pt-6 pb-[calc(7rem+env(safe-area-inset-bottom))] outline-none md:pb-12"
      >
        <Outlet />
      </main>
      {!desktop && <BottomNav />}
    </SearchOverlayProvider>
  );
}
