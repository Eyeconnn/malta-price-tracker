import { Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Notice } from '@/components/site/DealList';
import { useMode } from '@/components/site/ModeProvider';
import { SegmentedControl } from '@/components/site/SegmentedControl';
import { ShopBadge } from '@/components/site/ShopBadge';
import { SuggestShop } from '@/components/site/SuggestShop';
import { Button } from '@/components/ui/button';
import { ApiError, api, type ShopSummary, useApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DEFAULT_SETTINGS } from '../../../src/site/settings.js';

const count = new Intl.NumberFormat('en-GB');
const GRADES = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

/** A shop's RATING letter in a ring of its grade colour, or a grey "N/A" for a shop not rated yet (never a letter). */
export function ShopGrade({ grade, className }: { grade: ShopSummary['grade']; className?: string }) {
  if (grade === null) {
    return (
      <span className={cn('inline-flex h-10 flex-none items-center justify-center rounded-full border-2 border-current px-2.5 font-label text-[13px] font-semibold text-muted-foreground', className)}>
        <span className="sr-only">Rating </span>N/A
      </span>
    );
  }
  return (
    <span
      className={cn('inline-flex size-10 flex-none items-center justify-center rounded-full border-2 border-current font-label text-[22px] leading-none font-semibold', className)}
      style={{ color: `var(--grade-${grade.toLowerCase()})` }}
    >
      <span className="sr-only">Rating </span>
      <span>{grade}</span>
    </span>
  );
}

const products = (n: number) => `${count.format(n)} ${n === 1 ? 'product' : 'products'} tracked`;

/** Simple: a card per shop with its grade. */
function ShopCard({ shop, minJudged }: { shop: ShopSummary; minJudged: number }) {
  return (
    <li className="flex min-w-0">
      <Link
        to={`/shops/${encodeURIComponent(shop.slug)}`}
        className="frost flex w-full flex-col gap-3 rounded-[14px] p-[18px] text-ink shadow-(--shadow-tile) outline-none hover:border-ink focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="flex items-center gap-3">
          <ShopBadge name={shop.name} logoUrl={shop.logoUrl} logoAspect={shop.logoAspect} decorative />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[17px] font-bold">{shop.name}</span>
            <span className="text-[13px] text-muted-foreground">{products(shop.products)}</span>
          </span>
          <ShopGrade grade={shop.grade} />
        </span>
        <span className="text-sm">
          {shop.grade === null
            ? `Fewer than ${minJudged} Black Friday deals checked so far.`
            : `Rated ${shop.grade} from its judged Black Friday deals, worked out again every night.`}
        </span>
      </Link>
    </li>
  );
}

type Sort = 'best' | 'worst';

/** Best first: A to F; worst first: F to A. Shops not rated yet always come last, then by name. */
function sorted(shops: ShopSummary[], sort: Sort): ShopSummary[] {
  const rank = (s: ShopSummary) => (s.grade === null ? 99 : GRADES.indexOf(s.grade));
  return [...shops].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    if (x === 99 || y === 99) return x - y || a.name.localeCompare(b.name);
    return (sort === 'best' ? x - y : y - x) || a.name.localeCompare(b.name);
  });
}

/**
 * Shops: every shop we follow with its RATING (A to F, or N/A while it has too few judged deals), a search by name
 * and a best or worst first order. Advanced shows the same as a table. Below the list, visitors can suggest a shop.
 */
export function ShopsPage() {
  const { mode } = useMode();
  const advanced = mode === 'advanced';
  const findId = useId();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('best');
  const shops = useApi(
    'shops',
    (signal) => api.shops(signal),
    (d) => {
      if (!Array.isArray(d?.shops)) throw new ApiError(200); // a 200 without the expected shape
      return d.shops.length === 0;
    },
  );
  const thresholds = useApi('thresholds', (signal) => api.thresholds(signal));
  const minJudged = thresholds.status === 'ready' && thresholds.data?.thresholds ? thresholds.data.thresholds.minJudgedForRating : DEFAULT_SETTINGS.thresholds.minJudgedForRating;
  const list = useMemo(() => {
    if (shops.status !== 'ready') return [];
    const words = q.trim().toLowerCase();
    return sorted(
      shops.data.shops.filter((s) => !words || s.name.toLowerCase().includes(words)),
      sort,
    );
  }, [shops, q, sort]);

  return (
    <>
      <section className="flex flex-col gap-2">
        <h1 className="text-[26px] leading-tight font-bold tracking-[-0.01em] md:text-[32px]">Shops</h1>
        <p className="max-w-[760px] text-muted-foreground">
          Every shop gets a RATING from A to F, worked out again every night from its judged Black Friday deals: the share that were
          deals to avoid, plus half the share with a raised was price. Shops with fewer than {minJudged} judged deals are not rated yet.
        </p>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="glass flex max-w-[480px] min-w-0 flex-[1_1_320px] items-center gap-2 rounded-full py-1 pr-1.5 pl-4">
          <Search aria-hidden="true" className="size-[18px] flex-none text-faint" />
          <label htmlFor={findId} className="sr-only">
            Find a shop
          </label>
          <input
            id={findId}
            type="search"
            placeholder="Find a shop"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-h-11 w-full min-w-0 border-0 bg-transparent text-[15px] font-medium text-ink outline-none placeholder:text-faint"
          />
        </div>
        <SegmentedControl
          label="Sort shops"
          items={[
            { value: 'best', label: 'Best rated first' },
            { value: 'worst', label: 'Worst rated first' },
          ]}
          value={sort}
          onValueChange={setSort}
        />
      </div>

      {(shops.status === 'idle' || shops.status === 'loading') && <div role="status" aria-label="Loading shops" className="glass h-56 opacity-60" />}
      {shops.status === 'error' && (
        <Notice
          title="Shops could not be loaded."
          action={
            <Button variant="outline" onClick={shops.retry}>
              Try again
            </Button>
          }
        >
          Check your connection and try again.
        </Notice>
      )}
      {shops.status === 'empty' && <Notice title="No shops to show yet." />}
      {shops.status === 'ready' && list.length === 0 && <Notice title="No shop matches that name." />}
      {shops.status === 'ready' && list.length > 0 && !advanced && (
        <ul className="m-0 grid list-none gap-4 p-0 md:grid-cols-2 lg:grid-cols-3">
          {list.map((s) => (
            <ShopCard key={s.slug} shop={s} minJudged={minJudged} />
          ))}
        </ul>
      )}
      {shops.status === 'ready' && list.length > 0 && advanced && (
        <div className="glass overflow-x-auto p-2.5">
          <table className="data-table">
            <caption className="sr-only">Shops and their ratings</caption>
            <thead>
              <tr>
                <th scope="col">Shop</th>
                <th scope="col">Rating</th>
                <th scope="col" className="r">
                  Products tracked
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.slug}>
                  <th scope="row">
                    <Link to={`/shops/${encodeURIComponent(s.slug)}`} className="inline-flex items-center gap-2 font-bold text-ink outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
                      <ShopBadge name={s.name} logoUrl={s.logoUrl} logoAspect={s.logoAspect} size="sm" decorative />
                      {s.name}
                    </Link>
                  </th>
                  <td>
                    {s.grade === null ? (
                      <span className="font-semibold text-muted-foreground">N/A</span>
                    ) : (
                      <span className="t-num text-lg" style={{ color: `var(--grade-${s.grade.toLowerCase()})` }}>
                        {s.grade}
                      </span>
                    )}
                  </td>
                  <td className="r tabular-nums">{count.format(s.products)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <SuggestShop />
    </>
  );
}
