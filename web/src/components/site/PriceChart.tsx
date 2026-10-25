import { ChartLine } from '@/components/ui/chart-line';
import type { ChartDatum, ChartSeries } from '@/components/ui/chart-line-utils/chart-kit';
import { formatDay } from '@/lib/format';
import type { DayRow } from '@/lib/history';

/** One seller's line: its days (one variant), its legend name and its own term for the was price. */
export type PriceLine = { id: number; legend: string; rows: DayRow[]; wasName: string };

/** The first line (the best shop) is the accent and thickest; the others are quieter. */
const COLOURS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--accent-dark)', 'var(--muted)'];

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const dayOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** Every day from the first to the last of any line: a day a shop was not read stays empty, so its line breaks. */
export function chartRows(lines: PriceLine[]): ChartDatum[] {
  const days = lines.flatMap((l) => l.rows.map((r) => dayNumber(r.day)));
  if (days.length === 0) return [];
  const from = Math.min(...days);
  const to = Math.max(...days);
  const byLine = lines.map((l) => new Map(l.rows.map((r) => [r.day, r])));
  const out: ChartDatum[] = [];
  for (let n = from; n <= to; n++) {
    const day = dayOf(n);
    const row: ChartDatum = { day: formatDay(day) };
    lines.forEach((l, i) => {
      const r = byLine[i]!.get(day);
      row[`p${l.id}`] = r?.price != null ? r.price / 100 : null;
      row[`w${l.id}`] = r?.was != null && r.price != null && r.was > r.price ? r.was / 100 : null;
    });
    out.push(row);
  }
  return out;
}

/**
 * Each shop's price as a line, the best shop first and solid, the others quieter, and every shown was price as a
 * dashed line behind one "Was prices" legend toggle. The plot is keyboard readable (arrow keys); the same prices are
 * in the price by day table.
 */
export default function PriceChart({ lines, animate, label }: { lines: PriceLine[]; animate: boolean; label: string }) {
  const data = chartRows(lines);
  const series: ChartSeries[] = lines.map((l, i) => ({ key: `p${l.id}`, label: l.legend, color: COLOURS[i % COLOURS.length], width: i === 0 ? 3.5 : 2.2 }));
  const was = lines.filter((l) => l.rows.some((r) => r.was !== null && r.price !== null && r.was > r.price));
  for (const l of was) {
    series.push({ key: `w${l.id}`, label: `${l.legend} ${l.wasName}`, color: COLOURS[lines.indexOf(l) % COLOURS.length], dashed: true });
  }
  const terms = new Set(was.map((l) => l.wasName));
  const wasLegend = terms.size === 1 ? `${[...terms][0]!.charAt(0).toUpperCase()}${[...terms][0]!.slice(1)}s` : 'Was prices';
  const values = data.flatMap((d) => series.map((s) => d[s.key])).filter((v): v is number => typeof v === 'number');
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  // room below the lowest price, so changes are visible without starting the axis at zero
  const yMin = Math.max(0, Math.floor((low - (high - low || low * 0.1) * 0.35) / 10) * 10);
  return (
    <div data-animate={animate ? 'true' : 'false'} data-was-lines={was.length}>
      <ChartLine
        bare
        surface="site"
        data={data}
        index="day"
        series={series}
        curve="step"
        fill="dots"
        total="none"
        yMin={yMin}
        height={260}
        valueFormat="currency"
        currency="EUR"
        decimals={2}
        animate={animate}
        wasLegend={wasLegend}
        ariaLabel={label}
        icon={null}
      />
    </div>
  );
}
