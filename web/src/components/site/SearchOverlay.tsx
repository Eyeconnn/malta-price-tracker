import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
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

/**
 * Owns the search overlay: a modal dialog over the current page that holds the same live search as the
 * home page. It never navigates by itself, so closing it leaves the page exactly as it was (route,
 * scroll position, focus). Choosing a result or pressing Enter navigates normally and the overlay
 * closes with the route change. The typed text is kept while the page stays, and cleared by a navigation.
 * Must sit inside the router.
 */
export function SearchOverlayProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const opener = useRef<HTMLElement | null>(null);
  const scrollY = useRef<number | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY);
  const { key } = useLocation();

  const openSearch = useCallback((from?: HTMLElement | null) => {
    const active = document.activeElement;
    opener.current = from ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    scrollY.current = window.scrollY;
    setOpen(true);
  }, []);

  // A route change (a chosen result, Enter, Back) closes the overlay and forgets the query. The old
  // scroll position then belongs to the previous page, so it is not restored.
  const lastKey = useRef(key);
  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    scrollY.current = null;
    setQuery('');
    setOpen(false);
  }, [key]);

  // "/" or Ctrl+K (Cmd+K) opens the overlay unless the focus is in a text field or another dialog is open.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat || e.altKey) return;
      const slash = e.key === '/' && !e.ctrlKey && !e.metaKey;
      const k = (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k';
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
      <Dialog open={open} onOpenChange={setOpen}>
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
              // runs after the closing animation, once the dialog is gone: put focus and scroll back
              e.preventDefault();
              if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
              if (scrollY.current !== null && window.scrollY !== scrollY.current) window.scrollTo(0, scrollY.current);
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
            <LiveSearch animated className="max-w-none" value={query} onValueChange={setQuery} />
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </SearchOverlayContext.Provider>
  );
}
