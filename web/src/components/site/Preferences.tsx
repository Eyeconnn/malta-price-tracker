import { useId } from 'react';
import { type Theme, useMode } from '@/components/site/ModeProvider';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

/** The Simple/Advanced switch. The whole row is the touch target. */
export function ModeSwitch({ className }: { className?: string }) {
  const { mode, setMode } = useMode();
  const id = useId();
  return (
    <div className={cn('flex min-h-11 items-center gap-3', className)}>
      <label htmlFor={id} className="flex min-h-11 flex-1 items-center text-sm font-medium">
        Advanced mode
      </label>
      <Switch
        id={id}
        checked={mode === 'advanced'}
        onCheckedChange={(on) => setMode(on ? 'advanced' : 'simple')}
        // grow the tap area past the small visual switch to 44px
        className="relative after:absolute after:-inset-x-2 after:-inset-y-3.5 after:content-['']"
      />
    </div>
  );
}

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** System / Light / Dark. Arrow keys move between the options. */
export function ThemeChoice({ className }: { className?: string }) {
  const { theme, setTheme } = useMode();
  return (
    <ToggleGroup
      type="single"
      role="radiogroup"
      aria-label="Theme"
      variant="outline"
      value={theme}
      // pressing the chosen option again reports '', which keeps the current theme
      onValueChange={(v) => {
        if (v === 'system' || v === 'light' || v === 'dark') setTheme(v);
      }}
      className={cn('w-full', className)}
    >
      {THEMES.map(({ value, label }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          className="h-11 flex-1 px-4 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary data-[state=on]:hover:text-primary-foreground"
        >
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
