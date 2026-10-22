// The Advanced price chart (Recharts). Loaded with React.lazy from the product page, so Simple mode
// and every other page never download Recharts. Colours are the CSS tokens, so both themes work.
import { CartesianGrid, ComposedChart, Line, ReferenceArea, Tooltip, XAxis, YAxis } from 'recharts';
import { formatDay, formatEuro } from '@/lib/format';
import { type DayRow, rowIndex } from '@/lib/history';

export type PriceChartProps = {
  /** oldest first */
  rows: DayRow[];
  /** false under prefers-reduced-motion */
  animate: boolean;
};

const DAY_MS = 86_400_000;
const isoDay = (idx: number) => new Date(idx * DAY_MS).toISOString().slice(0, 10);

/** Consecutive days with the same worth-buying answer, as background bands (half a day either side). */
function bands(rows: DayRow[]): { x1: number; x2: number; worth: boolean }[] {
  const out: { x1: number; x2: number; worth: boolean }[] = [];
  for (const r of rows) {
    if (r.worth === null) continue;
    const x = rowIndex(r);
    const last = out.at(-1);
    if (last && last.worth === r.worth && last.x2 === x - 0.5) last.x2 = x + 0.5;
    else out.push({ x1: x - 0.5, x2: x + 0.5, worth: r.worth });
  }
  return out;
}

/** About five evenly spaced day ticks, always including the first and the last day. */
function ticks(first: number, last: number): number[] {
  const span = last - first;
  if (span <= 7) return Array.from({ length: span + 1 }, (_, i) => first + i);
  const step = Math.ceil(span / 4);
  const out: number[] = [];
  for (let x = last; x >= first; x -= step) out.unshift(x);
  if (out[0] !== first && out[0]! - first >= step / 2) out.unshift(first);
  return out;
}

const euroTick = (cents: number) => `€${Math.round(cents / 100).toLocaleString('en-US')}`;

/** Price line, dashed was line and green / red bands for days worth buying or not. */
export default function PriceChart({ rows, animate }: PriceChartProps) {
  const data = rows.map((r) => ({ x: rowIndex(r), price: r.price, was: r.was }));
  if (data.length === 0) return null;
  const first = data[0]!.x;
  const last = data.at(-1)!.x;
  return (
    <div data-animate={String(animate)}>
      <ComposedChart
        responsive
        data={data}
        accessibilityLayer={false}
        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        style={{ width: '100%', height: 220 }}
      >
        {bands(rows).map((b) => (
          <ReferenceArea
            key={b.x1}
            x1={b.x1}
            x2={b.x2}
            fill={b.worth ? 'var(--good)' : 'var(--bad)'}
            fillOpacity={0.1}
            stroke="none"
            ifOverflow="hidden"
          />
        ))}
        <CartesianGrid stroke="var(--line)" vertical={false} />
        <XAxis
          dataKey="x"
          type="number"
          domain={[first - 0.5, last + 0.5]}
          ticks={ticks(first, last)}
          tickFormatter={(x: number) => formatDay(isoDay(x))}
          tick={{ fill: 'var(--muted)', fontSize: 11 }}
          stroke="var(--line)"
        />
        <YAxis
          width={56}
          domain={['auto', 'auto']}
          tickFormatter={euroTick}
          tick={{ fill: 'var(--muted)', fontSize: 11 }}
          stroke="var(--line)"
        />
        <Tooltip
          isAnimationActive={animate}
          labelFormatter={(x) => formatDay(isoDay(Number(x)))}
          formatter={(v, name) => [typeof v === 'number' && v > 0 ? formatEuro(v) : 'Not shown', name === 'was' ? 'Was price' : 'Price']}
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--ink)' }}
          labelStyle={{ color: 'var(--ink)' }}
        />
        <Line
          type="stepAfter"
          dataKey="was"
          name="was"
          stroke="var(--muted)"
          strokeWidth={2}
          strokeDasharray="5 4"
          dot={false}
          isAnimationActive={animate}
        />
        <Line
          type="stepAfter"
          dataKey="price"
          name="price"
          stroke="var(--accent)"
          strokeWidth={2.6}
          dot={data.length <= 7 ? { r: 3, fill: 'var(--accent)' } : false}
          isAnimationActive={animate}
        />
      </ComposedChart>
    </div>
  );
}
