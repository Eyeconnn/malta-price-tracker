"use client";

// Shared pieces for the chart components in components/ui (chart-line.tsx): theme, series colours,
// number formatting, nice axis ticks, line paths, the reveal-on-scroll hook, and the card, legend,
// pattern and tooltip parts. Everything is plain React + SVG; motion is only used for the tooltip fade.

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ types */

/** One row of chart data: the index label plus numeric values by key. */
export type ChartDatum = Record<string, string | number | null | undefined>;

/** How a series is drawn when it is filled or shown in a legend. */
export type ChartTexture = "solid" | "dots" | "hatch";

/** A numeric key to plot. Colour falls back to the palette, label to the key. */
export interface ChartSeries {
  key: string;
  label?: string;
  color?: string;
  texture?: ChartTexture;
  /** a quieter reference line (a was price): dashed, thin, no fill; all dashed series share one legend toggle */
  dashed?: boolean;
  /** line thickness in px, overriding the chart's strokeWidth */
  width?: number;
}

/** A series with its label and colour worked out. */
export interface ResolvedSeries {
  key: string;
  label: string;
  color: string;
  texture?: ChartTexture;
  dashed?: boolean;
  width?: number;
}

export type ChartCurve = "smooth" | "linear" | "step";

export type Point = [number, number];

/** Built-in value formats, or your own function. "percent" takes values already in percent (12.5 means 12.5%). */
export type ValueFormat =
  | "number"
  | "compact"
  | "currency"
  | "percent"
  | ((value: number) => string);

/** "dark" and "light" are fixed palettes; "site" reads the app's CSS variables, so it follows the site theme. */
export type ChartSurface = "dark" | "light" | "site";

export type ChartTitleSize = "sm" | "md" | "lg";

/** Props every chart shares: the card around it, colours, motion and number format. */
export interface ChartBaseProps {
  title?: string;
  description?: ReactNode;
  /** Size of the title and headline figure. Default: "md" */
  titleSize?: ChartTitleSize;
  /** Colour scheme of the card. Default: "dark" */
  surface?: ChartSurface;
  /** Colour of the first series, focus ring and markers. Default: the surface's accent */
  accent?: string;
  /** Colours for the series, in order. Default: the surface's palette */
  palette?: string[];
  /** Small icon next to the title. Pass null for none. */
  icon?: ReactNode;
  /** Card corner radius in px. Default: 16 */
  radius?: number;
  /** Drop the card chrome (background, border, padding). Default: false */
  bare?: boolean;
  /** Animate on first view. Turned off for people who prefer reduced motion. Default: true */
  animate?: boolean;
  /** Draw time in seconds. Default: 1.2 */
  duration?: number;
  /** Start delay in seconds. Default: 0 */
  delay?: number;
  /** Animate only the first time the chart scrolls into view. Default: true */
  once?: boolean;
  /** Format for the headline, tooltip and axis. Default: "number" */
  valueFormat?: ValueFormat;
  /** ISO currency code for valueFormat "currency". Default: "USD" */
  currency?: string;
  /** Fraction digits for the formatter. */
  decimals?: number;
  className?: string;
}

/* ------------------------------------------------------------------ theme */

export interface ChartTheme {
  surface: ChartSurface;
  /** plot background: used to punch holes behind markers */
  bg: string;
  /** card background */
  card: string;
  fg: string;
  muted: string;
  /** stronger line, e.g. the zero line */
  subtle: string;
  grid: string;
  border: string;
  accent: string;
  tooltipBg: string;
  shadow: string;
  good: string;
  bad: string;
  palette: string[];
}

const SURFACES: Record<ChartSurface, Omit<ChartTheme, "surface" | "accent" | "palette"> & { accent: string; rest: string[] }> = {
  dark: {
    bg: "#11141b",
    card: "#11141b",
    fg: "#eef0f4",
    muted: "#9097a3",
    subtle: "rgba(255,255,255,0.32)",
    grid: "rgba(255,255,255,0.09)",
    border: "rgba(255,255,255,0.09)",
    tooltipBg: "rgba(23,26,33,0.96)",
    shadow: "0 1px 2px rgba(0,0,0,0.4), 0 12px 32px rgba(0,0,0,0.35)",
    good: "#3ecf8e",
    bad: "#ff6b5e",
    accent: "#4da5fc",
    rest: ["#3ecf8e", "#f5a05a", "#c4a5ff", "#ff6b5e", "#e8c547"],
  },
  light: {
    bg: "#ffffff",
    card: "#ffffff",
    fg: "#1b1d22",
    muted: "#6a6e77",
    subtle: "rgba(20,22,28,0.35)",
    grid: "rgba(20,22,28,0.09)",
    border: "rgba(20,22,28,0.1)",
    tooltipBg: "rgba(255,255,255,0.97)",
    shadow: "0 1px 2px rgba(20,22,28,0.06), 0 10px 30px rgba(20,22,28,0.08)",
    good: "#137e4e",
    bad: "#c2321f",
    accent: "#136cd5",
    rest: ["#137e4e", "#a8501a", "#6d3fc4", "#c2321f", "#846800"],
  },
  site: {
    bg: "var(--surface)",
    card: "var(--glass)",
    fg: "var(--ink)",
    muted: "var(--muted)",
    subtle: "var(--muted)",
    grid: "var(--line)",
    border: "var(--line)",
    tooltipBg: "var(--surface)",
    shadow: "var(--shadow)",
    good: "var(--good)",
    bad: "var(--bad)",
    accent: "var(--accent)",
    rest: ["var(--good)", "var(--bad)", "var(--ink)", "var(--muted)"],
  },
};

/** The colours for a surface, with an optional accent replacing its first colour. */
export function chartTheme(surface: ChartSurface = "dark", accent?: string): ChartTheme {
  const s = SURFACES[surface] ?? SURFACES.dark;
  const a = accent ?? s.accent;
  const { rest, ...base } = s;
  return { ...base, surface, accent: a, palette: [a, ...rest] };
}

/** Each series with a label and a colour (its own, else the palette's, cycling). */
export function resolveSeries(series: ChartSeries[], theme: ChartTheme, palette?: string[]): ResolvedSeries[] {
  const colours = palette && palette.length > 0 ? palette : theme.palette;
  return series.map((s, i) => ({
    key: s.key,
    label: s.label ?? s.key,
    color: s.color ?? colours[i % colours.length],
    texture: s.texture,
    dashed: s.dashed,
    width: s.width,
  }));
}

/* ------------------------------------------------------------------ numbers */

/** A finite number from a data cell; anything else counts as 0. */
export function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** A finite number from a data cell, or null when the cell is empty (a missing day breaks the line). */
export function toValue(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A short line in the series colour (dashed for a dashed series): the key of a line, never a dot. */
export function LineSwatch({ color, dashed = false }: { color: string; dashed?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn("swatch", dashed && "swatch-dashed")}
      style={{ color }}
    />
  );
}

/** A formatter for headline, tooltip and axis values. */
export function createFormatter(
  format: ValueFormat,
  opts: { currency?: string; decimals?: number } = {},
): (value: number) => string {
  if (typeof format === "function") return format;
  const { currency = "USD", decimals } = opts;
  switch (format) {
    case "currency": {
      const intl = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: decimals ?? 0,
        maximumFractionDigits: decimals ?? 0,
      });
      return (v) => intl.format(v);
    }
    case "percent": {
      const d = decimals ?? 1;
      return (v) => `${Number(v.toFixed(d)).toLocaleString("en-US", { maximumFractionDigits: d })}%`;
    }
    case "compact": {
      const intl = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: decimals ?? 1 });
      return (v) => intl.format(v);
    }
    default: {
      const intl = new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals ?? 2 });
      return (v) => intl.format(v);
    }
  }
}

const clean = (v: number) => Number(v.toPrecision(12));

/** About `count` evenly spaced round ticks covering [min, max] (steps of 1, 2, 2.5 or 5 times a power of ten). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad;
    max += pad;
    if (min < 0 && max > 0 && min >= -pad) min = 0;
  }
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(clean(v));
  return out.length > 1 ? out : [clean(start), clean(start + step)];
}

/* ------------------------------------------------------------------ paths */

const f = (v: number) => String(Math.round(v * 100) / 100);

/**
 * An SVG path through the points. "smooth" is a monotone cubic curve (it never overshoots the data,
 * so a price line never dips below its real low), "step" holds each value until the next point.
 * The same number of points always gives the same commands, so paths can morph into each other.
 */
export function linePath(pts: Point[], curve: ChartCurve = "smooth"): string {
  if (pts.length === 0) return "";
  const [x0, y0] = pts[0];
  if (pts.length === 1) return `M${f(x0)},${f(y0)}`;
  if (curve === "linear") return pts.map(([x, y], i) => `${i ? "L" : "M"}${f(x)},${f(y)}`).join("");
  if (curve === "step") {
    let d = `M${f(x0)},${f(y0)}`;
    for (let i = 1; i < pts.length; i++) d += `L${f(pts[i][0])},${f(pts[i - 1][1])}L${f(pts[i][0])},${f(pts[i][1])}`;
    return d;
  }
  // monotone X (Fritsch-Carlson)
  const n = pts.length;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    m[i] = dx[i] === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t[i] = 0;
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
    }
  }
  t[n - 1] = m[n - 2];
  let d = `M${f(x0)},${f(y0)}`;
  for (let i = 0; i < n - 1; i++) {
    const [xa, ya] = pts[i];
    const [xb, yb] = pts[i + 1];
    const h = dx[i] / 3;
    d += `C${f(xa + h)},${f(ya + t[i] * h)},${f(xb - h)},${f(yb - t[i + 1] * h)},${f(xb)},${f(yb)}`;
  }
  return d;
}

/* ------------------------------------------------------------------ motion */

function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/**
 * Reveals a chart when it scrolls into view. `still` is true when animation is off or the visitor
 * prefers reduced motion: the chart is then drawn at once with no movement.
 */
export function useChartReveal(once = true, animated = true) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const still = !animated || reduced;
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (still) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true);
          if (once) io.disconnect();
        } else if (!once) setInView(false);
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [once, still]);
  return { ref, shown: still || inView, still };
}

/* ------------------------------------------------------------------ parts */

const TITLE: Record<ChartTitleSize, string> = { sm: "text-sm", md: "text-[15px]", lg: "text-lg" };
const VALUE: Record<ChartTitleSize, string> = { sm: "text-2xl", md: "text-3xl", lg: "text-4xl" };

/** The card around a chart: icon and title, an optional headline figure with a change pill, then the chart. */
export function ChartCard({
  theme,
  title,
  description,
  titleSize = "md",
  value,
  delta,
  icon,
  radius = 16,
  bare = false,
  className,
  children,
}: {
  theme: ChartTheme;
  title?: string;
  description?: ReactNode;
  titleSize?: ChartTitleSize;
  value?: ReactNode;
  delta?: number;
  icon?: ReactNode;
  radius?: number;
  bare?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const hasHead = title !== undefined || description !== undefined || value !== undefined;
  const up = delta !== undefined && delta > 0;
  const flat = delta !== undefined && Math.abs(delta) < 0.05;
  return (
    <div
      className={cn("w-full min-w-0", !bare && "border p-5 sm:p-6", className)}
      style={
        bare
          ? { color: theme.fg }
          : { background: theme.card, borderColor: theme.border, color: theme.fg, borderRadius: radius, boxShadow: theme.shadow }
      }
    >
      {hasHead && (
        <div className="mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 items-start gap-2.5">
            {icon !== null && icon !== undefined && (
              <span
                aria-hidden="true"
                className="mt-0.5 inline-flex size-6 flex-none items-center justify-center rounded-md"
                style={{ background: `color-mix(in srgb, ${theme.accent} 16%, transparent)`, color: theme.accent }}
              >
                {icon}
              </span>
            )}
            <div className="min-w-0">
              {title !== undefined && <h3 className={cn("m-0 font-semibold leading-snug", TITLE[titleSize])}>{title}</h3>}
              {description !== undefined && (
                <p className="m-0 mt-0.5 text-xs" style={{ color: theme.muted }}>
                  {description}
                </p>
              )}
            </div>
          </div>
          {value !== undefined && (
            <div className="flex items-baseline gap-2">
              <span className={cn("font-semibold tracking-tight tabular-nums", VALUE[titleSize])}>{value}</span>
              {delta !== undefined && Number.isFinite(delta) && (
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums"
                  style={{
                    color: flat ? theme.muted : up ? theme.good : theme.bad,
                    background: `color-mix(in srgb, ${flat ? theme.muted : up ? theme.good : theme.bad} 14%, transparent)`,
                  }}
                >
                  <span className="sr-only">Change: </span>
                  {flat ? "0%" : `${up ? "+" : ""}${delta.toFixed(1)}%`}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

/** Series names as buttons: pressing one hides or shows its line. */
export function ChartLegend({
  series,
  theme,
  hidden,
  onToggle,
}: {
  series: ResolvedSeries[];
  theme: ChartTheme;
  hidden: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Lines on the chart">
      {series.map((s) => {
        const off = hidden.has(s.key);
        return (
          <li key={s.key}>
            <button
              type="button"
              aria-pressed={!off}
              onClick={() => onToggle(s.key)}
              className="inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-[12.5px] font-semibold transition-opacity outline-offset-2 hover:border-current focus-visible:outline-2"
              style={{ borderColor: theme.border, color: theme.fg, opacity: off ? 0.45 : 1, outlineColor: theme.accent }}
            >
              <LineSwatch color={s.color} dashed={s.dashed} />
              <span className={off ? "line-through" : undefined}>{s.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** An SVG <pattern> to fill an area: solid, dots or diagonal hatch in the series colour. Place it inside <defs>. */
export function ChartPattern({
  id,
  color,
  texture,
}: {
  id: string;
  color: string;
  texture: ChartTexture;
  theme?: ChartTheme;
}) {
  if (texture === "hatch") {
    return (
      <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeWidth="1.6" />
      </pattern>
    );
  }
  if (texture === "dots") {
    return (
      <pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse">
        <circle cx="1.25" cy="1.25" r="1.1" fill={color} />
        <circle cx="3.75" cy="3.75" r="1.1" fill={color} />
      </pattern>
    );
  }
  return (
    <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="4" fill={color} />
    </pattern>
  );
}

/** The hover / keyboard tooltip. It sits right of the crosshair, or left of it near the right edge. */
export function ChartTooltip({
  open,
  x,
  y,
  width,
  title,
  rows,
  theme,
}: {
  open: boolean;
  x: number;
  y: number;
  width: number;
  title?: string;
  rows: { label: string; value: string; color: string; dashed?: boolean }[];
  theme: ChartTheme;
}) {
  const flip = x > width - 190;
  return (
    <motion.div
      aria-hidden={!open}
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute top-0 left-0 z-10 min-w-44 rounded-[10px] border px-3 py-2.5 text-[12.5px]"
      style={{
        background: theme.tooltipBg,
        borderColor: theme.border,
        color: theme.fg,
        boxShadow: theme.shadow,
        left: x,
        top: y,
        translate: flip ? "calc(-100% - 14px) -50%" : "14px -50%",
        backdropFilter: "blur(8px)",
      }}
      initial={false}
      animate={{ opacity: open ? 1 : 0 }}
      transition={{ duration: 0.12 }}
    >
      {open && (
        <>
          {title && <div className="mb-1.5 font-semibold">{title}</div>}
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {rows.map((r) => (
              <li key={r.label} className="flex items-center gap-2">
                <LineSwatch color={r.color} dashed={r.dashed} />
                <span style={{ color: theme.muted }}>{r.label}</span>
                <span className="ml-auto pl-3 font-semibold tabular-nums">{r.value}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </motion.div>
  );
}
