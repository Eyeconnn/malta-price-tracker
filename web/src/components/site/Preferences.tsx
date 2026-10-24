import { Moon, Sun } from 'lucide-react';
import { useId } from 'react';
import { type Mode, type Theme, useMode } from '@/components/site/ModeProvider';
import { SegmentedControl } from '@/components/site/SegmentedControl';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/** The Advanced mode switch (the phone More sheet). The whole row is the touch target. */
export function ModeSwitch({ className }: { className?: string }) {
  const { mode, setMode } = useMode();
  const id = useId();
  return (
    <div className={cn('flex min-h-12 items-center gap-3', className)}>
      <label htmlFor={id} className="flex min-h-12 flex-1 cursor-pointer items-center font-semibold">
        Advanced mode
      </label>
      <Switch id={id} checked={mode === 'advanced'} onCheckedChange={(on) => setMode(on ? 'advanced' : 'simple')} />
    </div>
  );
}

const MODES: { value: Mode; label: string }[] = [
  { value: 'simple', label: 'Simple' },
  { value: 'advanced', label: 'Advanced' },
];

/** Simple / Advanced in the top bar: a segmented control on the smoked bar. */
export function ModeChoice({ className }: { className?: string }) {
  const { mode, setMode } = useMode();
  return <SegmentedControl bar size="bar" label="Detail" items={MODES} value={mode} onValueChange={(m) => setMode(m)} className={className} />;
}

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** System / Light / Dark (the More sheet). Arrow keys move between the options. */
export function ThemeChoice({ className }: { className?: string }) {
  const { theme, setTheme } = useMode();
  return (
    <SegmentedControl
      stretch
      label="Theme"
      items={THEMES}
      value={theme}
      onValueChange={(t, e) => setTheme(t, e?.currentTarget)}
      className={className}
    />
  );
}

/** One icon button in the top bar that flips between light and dark. */
export function ThemeButton({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useMode();
  const dark = resolvedTheme === 'dark';
  return (
    <button
      type="button"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={(e) => setTheme(dark ? 'light' : 'dark', e.currentTarget)}
      className={cn(
        'inline-flex size-[42px] items-center justify-center rounded-full border border-white/14 bg-white/6 text-white outline-none hover:bg-white/10 focus-visible:ring-[3px] focus-visible:ring-white/70',
        className,
      )}
    >
      {dark ? <Sun aria-hidden="true" className="size-[18px]" /> : <Moon aria-hidden="true" className="size-[18px]" />}
    </button>
  );
}
