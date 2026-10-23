import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { LiveSearch } from '@/components/site/SearchBox';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import { REDUCED_MOTION_QUERY } from '@/lib/useTypingPlaceholder';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { cn } from '@/lib/utils';

type SearchOverlayApi = {
  /** whether the overlay is open (for aria-expanded on the buttons that open it) */
  open: boolean;
  /** Opens the overlay; `opener` is the button to give focus back to on close. */
  openSearch: (opener?: HTMLElement | null) => void;
};

const SearchOverlayContext = createContext<SearchOverlayApi | null>(null);

/** The overlay's state and its opener: the Search buttons of the top nav and the bottom bar use this. */
export function useSearchOverlay(): SearchOverlayApi {
  const api = useContext(SearchOverlayContext);
  if (!api) throw new Error('useSearchOverlay needs a SearchOverlayProvider');
  return api;
}

/** Whether a key press happens in a place where typing "/" or "k" is text: a field, a select or editable content. */
function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('textarea, select, [contenteditable]:not([contenteditable="false"])')) return true;
  const input = target.closest('input');
  return input !== null && !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'file', 'image', 'color'].includes(input.type);
}

/** The history entry the overlay lives in is the page's own URL with this marker in its state. */
const MARKER = 'searchOverlay';
const isOverlayEntry = (state: unknown): boolean => typeof state === 'object' && state !== null && (state as Record<string, unknown>)[MARKER] === true;
const withoutMarker = (state: unknown): unknown => {
  if (typeof state !== 'object' || state === null) return state;
  const { [MARKER]: _marker, ...rest } = state as Record<string, unknown>;
  return Object.keys(rest).length > 0 ? rest : null;
};

/**
 * Owns the search overlay: a modal dialog over the current page that holds the same live search as the
 * home page. Opening adds one history entry with the same URL (state marker), so the phone's Back
 * button closes the overlay instead of leaving the page; closing with X or Escape goes back over that
 * entry, so Back from the page still reaches the page before. The overlay never changes the URL, so
 * closing leaves the page exactly as it was (route, scroll position, focus). Choosing a result or
 * pressing Enter replaces the overlay's entry with the new page and the overlay closes with it. The
 * typed text is kept while the page stays, and cleared once the overlay has closed after a navigation.
 * Must sit inside the router.
 */
export function SearchOverlayProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const open = isOverlayEntry(location.state);
  const [query, setQuery] = useState('');
  const opener = useRef<HTMLElement | null>(null);
  const scrollY = useRef<number | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY);

  const here = useRef(location);
  here.current = location;
  const isOpen = useRef(open);
  isOpen.current = open;
  /** a Back is on its way (history.back() answers later): further close requests must not go back again */
  const closing = useRef(false);
  /** the overlay was left by navigating to another page: no scroll or focus restore, clear the query once gone */
  const navigated = useRef(false);

  const openSearch = useCallback(
    (from?: HTMLElement | null) => {
      if (isOpen.current) return;
      const active = document.activeElement;
      opener.current = from ?? (active instanceof HTMLElement && active !== document.body ? active : null);
      scrollY.current = window.scrollY;
      navigated.current = false;
      const { pathname, search, hash, state } = here.current;
      const keep = typeof state === 'object' && state !== null ? state : {};
      navigate({ pathname, search, hash }, { state: { ...keep, [MARKER]: true } });
    },
    [navigate],
  );

  const closeSearch = useCallback(() => {
    if (!isOpen.current || closing.current) return;
    closing.current = true;
    navigate(-1);
  }, [navigate]);

  // What a change of the location means. Leaving the overlay entry for another page is a navigation;
  // leaving it for the same page (X, Escape, Back) is a plain close. While the overlay is closed, a
  // route change forgets the query at once.
  const page = location.pathname + location.search;
  const last = useRef({ page, open });
  useEffect(() => {
    const was = last.current;
    last.current = { page, open };
    if (!open) closing.current = false;
    if (was.open && !open && was.page !== page) {
      navigated.current = true;
      opener.current = null;
      scrollY.current = null;
    } else if (!was.open && !open && was.page !== page) {
      setQuery('');
    }
  }, [page, open]);

  // A reload keeps the marker in the history entry: do not come back up with the overlay already open.
  useEffect(() => {
    if (!isOpen.current) return;
    const { pathname, search, hash, state } = here.current;
    navigate({ pathname, search, hash }, { replace: true, state: withoutMarker(state) });
  }, [navigate]);

  // "/" or Ctrl+K (Cmd+K) opens the overlay unless the focus is in a text field or another dialog is open.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat || e.altKey) return;
      const slash = e.key === '/' && !e.ctrlKey && !e.metaKey;
      const k = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key.toLowerCase() === 'k' || e.code === 'KeyK');
      if (!slash && !k) return;
      if (inTextField(e.target) || document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      openSearch();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openSearch]);

  const api = useMemo(() => ({ open, openSearch }), [open, openSearch]);
  const animated = !reduced;

  return (
    <SearchOverlayContext.Provider value={api}>
      {children}
      <Dialog open={open} onOpenChange={(next) => !next && closeSearch()}>
        <DialogPortal>
          <DialogPrimitive.Overlay
            data-testid="search-backdrop"
            className={cn('fixed inset-0 z-50 bg-scrim backdrop-blur-sm', animated && 'search-overlay-animated')}
          />
          <DialogPrimitive.Content
            ref={content}
            aria-describedby={undefined}
            aria-modal="true"
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              content.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus({ preventScroll: true });
            }}
            onCloseAutoFocus={(e) => {
              // runs after the closing animation, once the dialog is gone
              e.preventDefault();
              if (navigated.current) {
                // a result was chosen: the new page's content gets the focus, not the nav button
                navigated.current = false;
                setQuery('');
                document.getElementById('main')?.focus({ preventScroll: true });
              } else {
                if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
                if (scrollY.current !== null && window.scrollY !== scrollY.current) window.scrollTo(0, scrollY.current);
              }
              opener.current = null;
              scrollY.current = null;
            }}
            className={cn(
              // phone: the whole screen; from 768px: a large panel hanging from the top, centred
              'search-overlay-panel fixed inset-0 z-50 flex flex-col gap-3 overflow-y-auto bg-popover p-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(1rem+env(safe-area-inset-bottom))] text-popover-foreground outline-none',
              'md:inset-x-0 md:top-[10vh] md:bottom-auto md:mx-auto md:max-h-[80dvh] md:w-[min(42rem,calc(100%-2rem))] md:rounded-2xl md:border md:border-line md:p-5 md:shadow-(--shadow)',
              animated && 'search-overlay-animated',
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <DialogTitle className="text-lg">Search products</DialogTitle>
              <DialogClose asChild>
                <Button variant="ghost" className="size-11" aria-label="Close search">
                  <X aria-hidden="true" className="size-5" />
                </Button>
              </DialogClose>
            </div>
            <LiveSearch animated replace className="max-w-none" value={query} onValueChange={setQuery} />
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </SearchOverlayContext.Provider>
  );
}
