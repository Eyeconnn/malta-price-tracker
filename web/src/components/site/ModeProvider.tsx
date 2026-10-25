import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';

export type Mode = 'simple' | 'advanced';
export type Theme = 'system' | 'light' | 'dark';

export type ModeContextValue = {
  mode: Mode;
  setMode: (mode: Mode) => void;
  theme: Theme;
  /** `from`: the pressed button, where the new theme's circle grows from */
  setTheme: (theme: Theme, from?: Element | null) => void;
  /** the theme actually shown: `theme`, or the device preference when it is 'system' */
  resolvedTheme: 'light' | 'dark';
};

// Keys shared with the first-paint script in web/index.html (it reads 'theme').
const MODE_KEY = 'mode';
const THEME_KEY = 'theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage blocked (private browsing, disabled site data): the choice lasts for this visit only
  }
}

function query(q: string): MediaQueryList | null {
  try {
    return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(q) : null;
  } catch {
    return null;
  }
}
const darkQuery = () => query(DARK_QUERY);

/** The theme the page shows now: data-theme on <html>, else the device preference. */
function shownTheme(): 'light' | 'dark' {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light' || t === 'dark') return t;
  return darkQuery()?.matches ? 'dark' : 'light';
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void> };
};

/** Paints the theme on <html> at once: data-theme for a manual choice, none for 'system'. */
function paint(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

const ModeContext = createContext<ModeContextValue | null>(null);

/**
 * Simple/Advanced mode and the colour theme, remembered in localStorage (defaults: Simple, follow
 * the device). A manual theme sets data-theme on <html>, which the `dark` variant in styles.css
 * reads; 'system' removes it so the prefers-color-scheme media query decides, and resolvedTheme
 * follows device changes.
 */
export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(() => (read(MODE_KEY) === 'advanced' ? 'advanced' : 'simple'));
  const [theme, setThemeState] = useState<Theme>(() => {
    const t = read(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  });
  const [deviceDark, setDeviceDark] = useState(() => darkQuery()?.matches ?? false);

  useEffect(() => {
    const mq = darkQuery();
    if (!mq) return;
    const onChange = (e: { matches: boolean }) => setDeviceDark(e.matches);
    setDeviceDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => paint(theme), [theme]);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    write(MODE_KEY, m);
  }, []);

  /*
   * Light and dark never cut. With View Transitions a circle of the new theme grows from the pressed button (650ms);
   * data-theme is set inside the transition's own callback, in the same frame, because a React state update would
   * land after the snapshot (a delay, then a hard cut). Without them every colour cross-fades for 0.5s. With
   * reduced motion it switches at once.
   */
  const setTheme = useCallback((t: Theme, from?: Element | null) => {
    write(THEME_KEY, t === 'system' ? null : t);
    const next = t === 'system' ? (darkQuery()?.matches ? 'dark' : 'light') : t;
    const apply = () => {
      paint(t);
      flushSync(() => setThemeState(t));
    };
    if (next === shownTheme() || query('(prefers-reduced-motion: reduce)')?.matches) {
      apply();
      return;
    }
    const root = document.documentElement;
    const doc = document as ViewTransitionDocument;
    if (typeof doc.startViewTransition === 'function') {
      const box = from?.getBoundingClientRect();
      const x = box ? box.left + box.width / 2 : window.innerWidth / 2;
      const y = box ? box.top + box.height / 2 : 0;
      const far = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      doc
        .startViewTransition(apply)
        .ready.then(() => {
          root.animate(
            { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${far}px at ${x}px ${y}px)`] },
            { duration: 650, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', pseudoElement: '::view-transition-new(root)' },
          );
        })
        .catch(() => {});
      return;
    }
    root.classList.add('theming');
    window.setTimeout(() => root.classList.remove('theming'), 600);
    apply();
  }, []);

  const value = useMemo<ModeContextValue>(
    () => ({ mode, setMode, theme, setTheme, resolvedTheme: theme === 'system' ? (deviceDark ? 'dark' : 'light') : theme }),
    [mode, setMode, theme, setTheme, deviceDark],
  );
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error('useMode must be used inside <ModeProvider>');
  return ctx;
}
