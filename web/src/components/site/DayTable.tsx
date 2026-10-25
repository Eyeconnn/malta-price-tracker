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
  if (row.price === null) return <td />;
  if (!c) {
    return <td className="r text-xs text-muted-foreground">{row.prevHidden ? 'Previous day not shown by the shop' : 'No earlier price'}</td>;
  }
  if (c.cents === 0) return <td className="r text-muted-foreground">No change</td>;
  return (
    <td className={cn('r font-bold whitespace-nowrap tabular-nums', c.cents > 0 ? 'text-bad' : 'text-good')}>
      <span>{signedEuro(c.cents)}</span> <span>{signedPct(c.pct)}</span>
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
  /** the seller's own term for its reference price ("List price"), the Was column's header; absent: "Was" */
  wasLabel?: string;
  className?: string;
};

/**
 * Price by day for one variant, newest first: day, price, was price, change against the previous
 * tracked day (€ and %), whether the shop marked it Black Friday, and whether it was worth buying.
 * A day without a price says "Price not shown by the shop" and gets no change. This table is the
 * text alternative of the price chart.
 */
export function DayTable({ id, rows, judged, low30, wasLabel, className }: DayTableProps) {
  const newestFirst = [...rows].reverse();
  return (
    <div className="flex flex-col gap-2">
      <div className={cn('overflow-x-auto', className)}>
        <table id={id} className="data-table">
          <caption className="sr-only">Price by day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col" className="r">
                Price
              </th>
              <th scope="col" className="r">
                {wasLabel ?? 'Was'}
              </th>
              <th scope="col" className="r">
                Change
              </th>
              <th scope="col">Black Friday</th>
              {judged && <th scope="col">Worth buying</th>}
            </tr>
          </thead>
          <tbody>
            {newestFirst.map((r) => (
              <tr key={r.day}>
                <th scope="row" className="font-semibold whitespace-nowrap">
                  {formatDay(r.day)}
                </th>
                {r.price === null ? <td className="r text-xs text-muted-foreground">{NO_PRICE}</td> : <td className="r t-num text-[15px]">{formatEuro(r.price)}</td>}
                <td className="r text-muted-foreground tabular-nums">{r.was !== null ? formatEuro(r.was) : r.wasKnown ? 'None' : 'Not recorded'}</td>
                <ChangeCell row={r} />
                <td className={r.bf ? 'font-semibold' : 'text-muted-foreground'}>{r.bf ? 'Marked' : 'Not marked'}</td>
                {judged && <td className="text-muted-foreground">{r.worth === null ? '' : r.worth ? 'Yes' : 'No'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[13px] text-muted-foreground">
        {judged && low30 !== null
          ? `Worth buying: the price that day was at or below ${formatEuro(low30)}, the lowest price this verdict uses. Change is against the previous day we tracked.`
          : 'Days worth buying are shown only for a judged deal, on the variant the verdict is about. Change is against the previous day we tracked.'}
      </p>
    </div>
  );
}
