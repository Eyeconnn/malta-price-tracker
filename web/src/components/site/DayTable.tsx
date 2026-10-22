import { NO_PRICE } from '@/components/site/DealCard';
import { formatDay, formatEuro, signedPct } from '@/lib/format';
import type { DayRow } from '@/lib/history';
import { cn } from '@/lib/utils';

/** "+€90.00" / "-€20.00". */
function signedEuro(cents: number): string {
  return `${cents > 0 ? '+' : '-'}${formatEuro(Math.abs(cents))}`;
}

function ChangeCell({ row }: { row: DayRow }) {
  const c = row.change;
  if (row.price === null) return <td className="px-2 py-2" />;
  if (!c) {
    return (
      <td className="px-2 py-2 text-right text-xs text-muted-foreground">{row.prevHidden ? 'Previous day not shown by the shop' : 'No earlier price'}</td>
    );
  }
  if (c.cents === 0) return <td className="px-2 py-2 text-right text-muted-foreground">No change</td>;
  return (
    <td className={cn('px-2 py-2 text-right font-semibold whitespace-nowrap tabular-nums', c.cents > 0 ? 'text-bad' : 'text-good')}>
      <span>{signedEuro(c.cents)}</span> <span>{signedPct(c.pct)}</span>
    </td>
  );
}

function WorthCell({ worth }: { worth: boolean | null }) {
  if (worth === null) return <td className="px-2 py-2" />;
  return (
    <td className="px-2 py-2">
      <span className={cn('inline-block rounded-md border px-2 py-0.5 text-xs font-semibold', worth ? 'border-good text-good' : 'border-bad text-bad')}>
        {worth ? 'Yes' : 'No'}
      </span>
    </td>
  );
}

export type DayTableProps = {
  id: string;
  /** oldest first, as dayRows returns them; shown newest first */
  rows: DayRow[];
  /**
   * whether `worth` answers come from a good / avoid verdict about this variant; false (another
   * variant, or an insufficient / none verdict) leaves the Worth buying column out (Ruling R44)
   */
  judged: boolean;
  /** facts.low30, named in the note under the table */
  low30: number | null;
  className?: string;
};

/**
 * Price by day for one variant, newest first: day, price, was price, change against the previous
 * tracked day (€ and %), whether the shop marked it Black Friday, and whether it was worth buying.
 * A day without a price says "Price not shown by the shop" and gets no change. This table is the
 * text alternative of the price chart.
 */
export function DayTable({ id, rows, judged, low30, className }: DayTableProps) {
  const newestFirst = [...rows].reverse();
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table id={id} className="w-full border-collapse text-left text-sm">
        <caption className="pb-2 text-left font-semibold">Price by day</caption>
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th scope="col" className="px-2 py-1 font-medium">
              Day
            </th>
            <th scope="col" className="px-2 py-1 text-right font-medium">
              Price
            </th>
            <th scope="col" className="px-2 py-1 text-right font-medium">
              Was
            </th>
            <th scope="col" className="px-2 py-1 text-right font-medium">
              Change
            </th>
            <th scope="col" className="px-2 py-1 font-medium">
              Black Friday
            </th>
            {judged && (
              <th scope="col" className="px-2 py-1 font-medium">
                Worth buying
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {newestFirst.map((r) => (
            <tr key={r.day} className="border-t border-line align-top">
              <th scope="row" className="px-2 py-2 font-medium whitespace-nowrap">
                {formatDay(r.day)}
              </th>
              {r.price === null ? (
                <td className="px-2 py-2 text-right text-xs text-muted-foreground">{NO_PRICE}</td>
              ) : (
                <td className="px-2 py-2 text-right tabular-nums">{formatEuro(r.price)}</td>
              )}
              <td className="px-2 py-2 text-right text-muted-foreground tabular-nums">{r.was === null ? 'None' : formatEuro(r.was)}</td>
              <ChangeCell row={r} />
              <td className="px-2 py-2">{r.bf ? <span className="font-semibold">Marked</span> : <span className="text-muted-foreground">Not marked</span>}</td>
              {judged && <WorthCell worth={r.worth} />}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        {judged && low30 !== null
          ? `Worth buying: the price that day was at or below ${formatEuro(low30)}, the lowest price this verdict uses. Change is against the previous day we tracked.`
          : 'Days worth buying are shown only for a judged deal, on the variant the verdict is about. Change is against the previous day we tracked.'}
      </p>
    </div>
  );
}
