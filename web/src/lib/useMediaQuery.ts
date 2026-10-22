import { useCallback, useSyncExternalStore } from 'react';

function match(query: string): MediaQueryList | null {
  try {
    return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(query) : null;
  } catch {
    return null;
  }
}

/**
 * Whether a CSS media query currently matches, kept in step with the device. `fallback` is used
 * where matchMedia does not exist (tests without a stub).
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = match(query);
      if (!mq) return () => {};
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => match(query)?.matches ?? fallback,
    () => fallback,
  );
}
