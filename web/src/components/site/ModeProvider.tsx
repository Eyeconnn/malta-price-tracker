import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Mode = 'simple' | 'advanced';
export type Theme = 'system' | 'light' | 'dark';

export type ModeContextValue = {
  mode: Mode;
  setMode: (mode: Mode) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
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

function darkQuery(): MediaQueryList | null {
  try {
    return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(DARK_QUERY) : null;
  } catch {
    return null;
  }
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

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    write(MODE_KEY, m);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    write(THEME_KEY, t === 'system' ? null : t);
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
