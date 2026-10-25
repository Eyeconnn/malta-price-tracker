import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { REDUCED_MOTION_QUERY } from '@/lib/useTypingPlaceholder';

/** How long the old page's blocks take to slide away before the new page is shown. */
export const LEAVE_MS = 135;
/** The new page's blocks have all landed after this. */
const ENTER_MS = 260;

export type PagePhase = 'in' | 'out' | null;

const reduced = () => {
  try {
    return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
};

/**
 * A quick page change with no loading screen. A click on an in-app link first lets the current page's blocks slide
 * down and fade (LEAVE_MS), then navigates; on the new page the blocks drop into place one by one. The header and
 * the bottom bar are outside the animated wrapper, so the navigation stays still. Links in dialogs (the search
 * overlay manages its own history), links with a target or a download, modified clicks and reduced motion are left
 * alone. Returns the phase for the wrapper's data-phase.
 */
export function usePageTransition(): PagePhase {
  const location = useLocation();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<PagePhase>(() => (reduced() ? null : 'in'));
  const path = useRef(location.pathname);

  // a new page: its blocks settle in
  useLayoutEffect(() => {
    if (path.current === location.pathname) return;
    path.current = location.pathname;
    setPhase(reduced() ? null : 'in');
  }, [location.pathname]);

  useEffect(() => {
    if (phase !== 'in') return;
    const t = window.setTimeout(() => setPhase(null), ENTER_MS);
    return () => window.clearTimeout(t);
  }, [phase, location.pathname]);

  useEffect(() => {
    let timer: number | undefined;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || reduced()) return;
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      if (a.closest('[role="dialog"], [data-no-page-transition]')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname.startsWith('/admin') || url.pathname.startsWith('/api')) return;
      // the same page (a hash or a query change on it) needs no page change
      if (url.pathname === window.location.pathname) return;
      e.preventDefault();
      setPhase('out');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => navigate(url.pathname + url.search + url.hash), LEAVE_MS);
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.clearTimeout(timer);
    };
  }, [navigate]);

  return phase;
}
