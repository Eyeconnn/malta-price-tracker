import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

export type SegmentTone = 'ink' | 'good' | 'bad';

export type Segment<T extends string> = {
  value: T;
  label: ReactNode;
  /** the pill's colour while this option is chosen: ink (default), green for good deals, red for deals to avoid */
  tone?: SegmentTone;
  /** spoken name when the label is not plain text */
  ariaLabel?: string;
};

type Pill = { x: number; y: number; w: number; h: number };

/**
 * One row of options with a single selection pill that slides and resizes to the chosen option
 * (cubic-bezier(0.22, 1, 0.36, 1), 0.45s) while the option text colours cross-fade. Built on the shadcn
 * toggle group: a radio group, arrow keys move between options. The pill is measured from the chosen
 * option with a ResizeObserver; until it is measured, the chosen option keeps its own fill. `bar`: the
 * smoked top bar's version (white pill, white text).
 */
export function SegmentedControl<T extends string>({
  items,
  value,
  onValueChange,
  label,
  labelledBy,
  bar = false,
  stretch = false,
  size = 'md',
  className,
  itemClassName,
}: {
  items: Segment<T>[];
  value: T;
  onValueChange: (value: T, event?: { currentTarget: HTMLElement }) => void;
  /** aria-label of the group (or labelledBy) */
  label?: string;
  labelledBy?: string;
  bar?: boolean;
  /** options share the full width */
  stretch?: boolean;
  /** md: 40px options (44px group); bar: 34px options in the 42px top bar control */
  size?: 'md' | 'bar';
  className?: string;
  itemClassName?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<Pill | null>(null);
  const [animate, setAnimate] = useState(false);
  const chosen = items.find((i) => i.value === value);
  const tone = bar ? 'white' : (chosen?.tone ?? 'ink');

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>('[data-state="on"]');
      if (!on || !on.offsetWidth) {
        setPill(null);
        return;
      }
      setPill((p) => {
        const next = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
        return p && p.x === next.x && p.y === next.y && p.w === next.w && p.h === next.h ? p : next;
      });
    };
    place();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    document.fonts?.ready.then(place).catch(() => {});
    return () => ro?.disconnect();
  }, [value, items]);

  // slide only after the first placement, so the pill does not fly in from the corner
  useLayoutEffect(() => {
    if (!pill || animate) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setAnimate(true)));
    return () => cancelAnimationFrame(id);
  }, [pill, animate]);

  const measured = pill !== null;
  const pillStyle: CSSProperties | undefined = pill
    ? { width: pill.w, height: pill.h, transform: `translate(${pill.x}px, ${pill.y}px)` }
    : undefined;

  return (
    <ToggleGroup
      ref={root}
      type="single"
      value={value}
      aria-label={label}
      aria-labelledby={labelledBy}
      spacing={1}
      // every choice arrives through the option's click (Space and Enter press it too), with the pressed button
      onValueChange={() => {}}
      className={cn(
        'seg-group flex-wrap gap-1 rounded-full p-1',
        bar ? 'h-[42px] gap-0.5 border border-white/14 bg-white/8 p-[3px]' : 'border border-glass-edge bg-glass',
        stretch && 'w-full flex-nowrap',
        className,
      )}
    >
      {pill && <span aria-hidden="true" className="seg-pill" data-tone={tone} data-anim={animate ? 'true' : undefined} style={pillStyle} />}
      {items.map((item) => (
        <ToggleGroupItem
          key={item.value}
          value={item.value}
          aria-label={item.ariaLabel}
          onClick={(e) => {
            // the theme switch needs the pressed button to start its circle from
            if (item.value === value) return;
            onValueChange(item.value, { currentTarget: e.currentTarget });
          }}
          className={cn(
            'seg-item h-auto rounded-full border-0 bg-transparent font-semibold shadow-none outline-none hover:bg-transparent focus-visible:ring-[3px] focus-visible:ring-ring/60',
            size === 'bar' ? 'h-[34px] min-w-[88px] px-3.5 text-[13px]' : 'min-h-10 px-4 text-sm',
            stretch && 'flex-1 justify-center',
            bar
              ? 'text-white-muted hover:text-white data-[state=on]:text-[#1b1a19] data-[state=on]:hover:text-[#1b1a19] focus-visible:ring-white/70'
              : 'text-muted-foreground hover:text-ink data-[state=on]:hover:text-current',
            !bar && (item.tone === 'good' ? 'data-[state=on]:text-good-fill-ink' : item.tone === 'bad' ? 'data-[state=on]:text-bad-ink' : 'data-[state=on]:text-on-ink'),
            // until the pill is measured the chosen option is filled itself, so it is never missing
            !measured &&
              (bar
                ? 'data-[state=on]:bg-white'
                : item.tone === 'good'
                  ? 'data-[state=on]:bg-good-fill'
                  : item.tone === 'bad'
                    ? 'data-[state=on]:bg-bad-fill'
                    : 'data-[state=on]:bg-ink'),
            measured && 'data-[state=on]:bg-transparent',
            itemClassName,
          )}
        >
          {item.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
