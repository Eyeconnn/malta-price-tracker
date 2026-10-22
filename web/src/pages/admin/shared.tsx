// Pieces shared by the admin pages: the settings document they all edit, sections and save feedback.
import { type ReactNode, createContext, useCallback, useContext, useState } from 'react';
import type { SiteSettings } from '../../../../src/site/settings.js';
import { Notice } from '@/components/site/DealList';
import { Button } from '@/components/ui/button';
import { adminApi, adminErrorText } from '@/lib/admin-api';
import { type ApiState, useApi } from '@/lib/api';
import { cn } from '@/lib/utils';

type SettingsContext = {
  state: ApiState<{ settings: SiteSettings }> & { retry: () => void };
  /** PUTs the whole document; on success every admin page sees the stored copy */
  save: (next: SiteSettings) => Promise<SiteSettings>;
};

const Ctx = createContext<SettingsContext | null>(null);

/** Loads the settings once for all admin pages (Settings, Phrases, Thresholds edit parts of one document). */
export function AdminSettingsProvider({ children }: { children: ReactNode }) {
  const loaded = useApi('admin-settings', (signal) => adminApi.settings(signal));
  const [saved, setSaved] = useState<SiteSettings | null>(null);
  const save = useCallback(async (next: SiteSettings) => {
    const { settings } = await adminApi.saveSettings(next);
    setSaved(settings);
    return settings;
  }, []);
  const state: SettingsContext['state'] = saved && loaded.status === 'ready' ? { status: 'ready', data: { settings: saved }, retry: loaded.retry } : loaded;
  return <Ctx.Provider value={{ state, save }}>{children}</Ctx.Provider>;
}

export function useAdminSettings(): SettingsContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAdminSettings needs AdminSettingsProvider');
  return c;
}

/** Renders `children(settings)` once the settings are loaded; loading and error states otherwise. */
export function WithSettings({ children }: { children: (settings: SiteSettings) => ReactNode }) {
  const { state } = useAdminSettings();
  if (state.status === 'error')
    return (
      <Notice
        title="Settings could not be loaded."
        action={
          <Button variant="outline" className="min-h-11" onClick={state.retry}>
            Try again
          </Button>
        }
      >
        {adminErrorText(state.error)}
      </Notice>
    );
  if (state.status !== 'ready') return <div role="status" aria-label="Loading settings" className="glass h-40 opacity-60" />;
  return <>{children(state.data.settings)}</>;
}

export function Section({ title, description, children, className }: { title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('glass flex flex-col gap-4 p-5', className)} aria-label={title}>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
      </div>
      {children}
    </section>
  );
}

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; text?: string } | { kind: 'error'; text: string };

/** Polite status line after a save: "Saved." or the error. */
export function SaveMessage({ state }: { state: SaveState }) {
  return (
    <p role="status" className={cn('min-h-5 text-sm font-medium', state.kind === 'error' && 'text-bad')}>
      {state.kind === 'saved' ? (state.text ?? 'Saved.') : state.kind === 'error' ? state.text : state.kind === 'saving' ? 'Saving...' : ''}
    </p>
  );
}

/** Runs a save and turns its outcome into a SaveState. */
export function useSaver(): [SaveState, (run: () => Promise<unknown>, savedText?: string) => Promise<boolean>] {
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const run = useCallback(async (fn: () => Promise<unknown>, savedText?: string) => {
    setState({ kind: 'saving' });
    try {
      await fn();
      setState({ kind: 'saved', text: savedText });
      return true;
    } catch (e) {
      setState({ kind: 'error', text: adminErrorText(e) });
      return false;
    }
  }, []);
  return [state, run];
}

/** Previous / next page buttons with "Page 2 of 5". */
export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex items-center gap-3">
      <Button variant="outline" className="min-h-11" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span className="text-sm tabular-nums">
        Page {page} of {pages}
      </span>
      <Button variant="outline" className="min-h-11" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </nav>
  );
}

export const fieldClass =
  'min-h-11 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm dark:bg-input/30';
