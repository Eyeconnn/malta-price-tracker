// The Advanced product page chart: one price line per seller (Recharts), each line one variant of that seller's
// listing, never a mix. Loaded with React.lazy, so Simple mode never downloads Recharts.
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { formatDay, formatEuro } from '@/lib/format';
import { type DayRow, rowIndex } from '@/lib/history';
import { hasWas, seriesStyle, WAS_DASH } from '@/lib/sellerSeries';

/** wasName: the shop's own term for its reference price, in lower case ("list price"); absent: "was price" */
export type SellerLine = { id: number; shop: string; rows: DayRow[]; wasName?: string };
export type SellersChartProps = { lines: SellerLine[]; animate: boolean };

const DAY_MS = 86_400_000;
const isoDay = (idx: number) => new Date(idx * DAY_MS).toISOString().slice(0, 10);
const euroTick = (cents: number) => `€${Math.round(cents / 100).toLocaleString('en-US')}`;

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

export default function SellersChart({ lines, animate }: SellersChartProps) {
  const byDay = new Map<number, Record<string, number | null>>();
  for (const l of lines) {
    for (const r of l.rows) {
      const x = rowIndex(r);
      const point = byDay.get(x) ?? { x };
      point[`s${l.id}`] = r.price;
      point[`w${l.id}`] = typeof r.was === 'number' && r.was > 0 ? r.was : null;
      byDay.set(x, point);
    }
  }
  const data = [...byDay.values()].sort((a, b) => (a.x as number) - (b.x as number));
  if (data.length === 0) return null;
  const first = data[0]!.x as number;
  const last = data.at(-1)!.x as number;
  const names = new Map(lines.flatMap((l) => [[`s${l.id}`, l.shop], [`w${l.id}`, `${l.shop}, ${l.wasName ?? 'was price'}`]] as [string, string][]));
  const withWas = lines.map((l, i) => ({ l, i })).filter(({ l }) => hasWas(l));
  return (
    <div data-animate={String(animate)} data-lines={lines.length} data-was-lines={withWas.length}>
      <LineChart responsive data={data} accessibilityLayer={false} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} style={{ width: '100%', height: 240 }}>
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
        <YAxis width={56} domain={['auto', 'auto']} tickFormatter={euroTick} tick={{ fill: 'var(--muted)', fontSize: 11 }} stroke="var(--line)" />
        <Tooltip
          isAnimationActive={animate}
          labelFormatter={(x) => formatDay(isoDay(Number(x)))}
          formatter={(v, key) => [typeof v === 'number' && v > 0 ? formatEuro(v) : String(key).startsWith('w') ? 'None' : 'Not shown', names.get(String(key)) ?? '']}
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--ink)' }}
          labelStyle={{ color: 'var(--ink)' }}
        />
        {lines.map((l, i) => {
          const { stroke, dash } = seriesStyle(i);
          return (
            <Line
              key={l.id}
              type="stepAfter"
              dataKey={`s${l.id}`}
              name={`s${l.id}`}
              stroke={stroke}
              strokeWidth={2.4}
              strokeDasharray={dash || undefined}
              dot={l.rows.length <= 7 ? { r: 3, fill: stroke } : false}
              connectNulls
              isAnimationActive={animate}
            />
          );
        })}
        {withWas.map(({ l, i }) => {
          const { stroke } = seriesStyle(i);
          return (
            <Line
              key={`w${l.id}`}
              type="stepAfter"
              dataKey={`w${l.id}`}
              name={`w${l.id}`}
              stroke={stroke}
              strokeOpacity={0.6}
              strokeWidth={1.4}
              strokeDasharray={WAS_DASH}
              dot={false}
              connectNulls={false}
              isAnimationActive={animate}
            />
          );
        })}
      </LineChart>
    </div>
  );
}
