import { useId } from 'react';
import { Link, useParams } from 'react-router';
import { NO_PRICE } from '@/components/site/DealCard';
import { DealList, DealListSkeleton, Notice } from '@/components/site/DealList';
import { GlassCard } from '@/components/site/GlassCard';
import { useMode } from '@/components/site/ModeProvider';
import { RatingScale } from '@/components/site/RatingScale';
import { ReportButton } from '@/components/site/ReportButton';
import { LiveSearch } from '@/components/site/SearchBox';
import { ShopBadge } from '@/components/site/ShopBadge';
import { Button } from '@/components/ui/button';
import { ApiError, api, type Card, type Change, type ShopResponse, type ShopStats, useApi } from '@/lib/api';
import { formatDay, formatEuro } from '@/lib/format';
import { listingPath } from '@/lib/links';
import { cn } from '@/lib/utils';
import { wasTerms } from '../../../src/site/verdict.js';

/** Cards per list on a shop page. */
const LIST_MAX = 5;

const count = new Intl.NumberFormat('en-GB');

const LISTS = {
  avoid: { title: 'Deals to avoid here', none: 'No deals to avoid at this shop at the moment.', dot: 'bg-bad' },
  good: { title: 'Good deals here', none: 'No good deals at this shop at the moment.', dot: 'bg-good' },
} as const;

function DealSection({ kind, cards, slug }: { kind: keyof typeof LISTS; cards: Card[]; slug: string }) {
  const id = useId();
  const { title, none, dot } = LISTS[kind];
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={cn('size-2.5 rounded-full', dot)} />
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {cards.length > 0 && (
          <Link
            to={`/deals?${new URLSearchParams({ type: kind, shop: slug })}`}
            aria-label={`See all ${title.toLowerCase()}`}
            className="ml-auto inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-brand outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            See all
          </Link>
        )}
      </div>
      {cards.length > 0 ? <DealList cards={cards.slice(0, LIST_MAX)} /> : <Notice title={none} />}
    </section>
  );
}

/** Whole numbers stay whole, others get one decimal: 61 -> "61%", 12.74 -> "12.7%". */
const percent = (n: number) => `${Number(n.toFixed(1))}%`;

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
/** A count with thousands separators, or "Not shown" when the API did not send a finite number. */
const countText = (n: unknown) => (isCount(n) ? count.format(n) : 'Not shown');

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="glass flex flex-col gap-1 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('m-0 text-xl font-bold tabular-nums', tone === 'good' && 'text-good', tone === 'bad' && 'text-bad')}>{value}</dd>
    </div>
  );
}

/** Advanced: the four facts behind the rating. A null real-deal share is "Not enough judged yet", never 0%. */
function StatsBlock({ stats, wasLabel }: { stats: ShopStats; wasLabel?: string }) {
  const id = useId();
  const real = stats.realDealPct;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="sr-only">
        Shop statistics
      </h2>
      <dl className="m-0 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Real deals" value={real === null || !isCount(real) ? 'Not enough judged yet' : percent(real)} />
        <Stat label="Deals to avoid" value={countText(stats.avoid)} tone={isCount(stats.avoid) && stats.avoid > 0 ? 'bad' : undefined} />
        <Stat label={`${wasTerms(wasLabel).start} raised`} value={countText(stats.wasRaised)} tone={isCount(stats.wasRaised) && stats.wasRaised > 0 ? 'bad' : undefined} />
        <Stat label="Marked Black Friday" value={countText(stats.bfMarked)} />
      </dl>
    </section>
  );
}

/** A price worth showing: a positive, finite number of cents (never "€0.00"). */
const shown = (cents: number) => Number.isFinite(cents) && cents > 0;

function day(iso: string): string {
  try {
    return formatDay(iso);
  } catch {
    return '';
  }
}

function PriceCell({ cents, at }: { cents: number; at: string }) {
  if (!shown(cents)) return <td className="px-2 py-2 text-xs text-muted-foreground">{NO_PRICE}</td>;
  return (
    <td className="px-2 py-2 tabular-nums">
      {formatEuro(cents)}
      <span className="block text-xs text-muted-foreground">{day(at)}</span>
    </td>
  );
}

/** "+12.7%" for a rise, "-6%" for a drop. */
function signed(pct: number): string {
  if (!Number.isFinite(pct)) return '';
  return `${pct > 0 ? '+' : pct < 0 ? '-' : ''}${percent(Math.abs(pct))}`;
}

function ChangeTable({ caption, rows, tone, none }: { caption: string; rows: Change[]; tone: 'good' | 'bad'; none: string }) {
  return (
    <div className="glass p-3">
      {rows.length === 0 ? (
        <>
          <p className="font-semibold">{caption}</p>
          <p className="mt-2 text-sm text-muted-foreground">{none}</p>
        </>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="pb-2 text-left font-semibold">{caption}</caption>
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th scope="col" className="px-2 py-1 font-medium">
                  Product
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  Before
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  Now
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  Change
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line align-top">
                  <th scope="row" className="px-2 py-2 font-medium">
                    <Link
                      to={listingPath(r.id)}
                      className="rounded-sm outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {r.title}
                    </Link>
                  </th>
                  <PriceCell cents={r.fromCents} at={r.fromAt} />
                  <PriceCell cents={r.toCents} at={r.at} />
                  {shown(r.fromCents) && shown(r.toCents) ? (
                    <td className={cn('px-2 py-2 text-right font-semibold tabular-nums', tone === 'bad' ? 'text-bad' : 'text-good')}>{signed(r.pct)}</td>
                  ) : (
                    <td className="px-2 py-2 text-right text-xs text-muted-foreground">{NO_PRICE}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** "in the last 14 days" for the stored raise window the API sent; "recently" when it sent no usable number. */
function lastDays(n: unknown): string {
  return isCount(n) && n > 0 ? `in the last ${count.format(n)} ${n === 1 ? 'day' : 'days'}` : 'recently';
}

function ShopContent({ data, slug }: { data: ShopResponse; slug: string }) {
  const { mode } = useMode();
  const { shop, rating } = data;
  const changeWindow = lastDays(data.raiseWindowDays);
  return (
    <div className="flex flex-col gap-6">
      <div className="glass flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <ShopBadge name={shop.name} />
            <h1 className="min-w-0 text-2xl font-bold tracking-tight break-words">{shop.name}</h1>
          </div>
          <RatingScale grade={rating.grade} sentence={rating.sentence} />
          <ReportButton targetType="shop" targetId={shop.id} about={shop.name} />
        </div>
        <div className="w-full md:max-w-sm">
          <LiveSearch shop={slug} placeholder={`Search ${shop.name}`} className="max-w-none" />
        </div>
      </div>
      {mode === 'advanced' && <StatsBlock stats={data.stats} wasLabel={data.shop.wasLabel} />}
      <DealSection kind="avoid" cards={data.avoid} slug={slug} />
      <DealSection kind="good" cards={data.good} slug={slug} />
      {mode === 'advanced' && (
        <div className="grid gap-3 lg:grid-cols-2">
          <ChangeTable caption="Top price rises" rows={data.rises} tone="bad" none={`No price rises ${changeWindow}.`} />
          <ChangeTable caption="Top real drops" rows={data.drops} tone="good" none={`No price drops ${changeWindow}.`} />
        </div>
      )}
    </div>
  );
}

function NotFound() {
  return (
    <GlassCard className="p-6">
      <h1 className="text-2xl font-bold tracking-tight">Shop not found</h1>
      <p className="mt-2 text-muted-foreground">
        No shop is listed under that address.{' '}
        <Link to="/shops" className="font-medium text-brand underline underline-offset-4">
          All shops
        </Link>
      </p>
    </GlassCard>
  );
}

/** A shop: its rating, a search inside it, deals to avoid and good deals; Advanced adds statistics and price changes. */
export function ShopPage() {
  const { slug } = useParams();
  const state = useApi(
    slug ?? null,
    (signal) => api.shop(slug!, signal),
    (d) => {
      if (
        !d ||
        typeof d.shop?.name !== 'string' ||
        !d.rating ||
        !Array.isArray(d.avoid) ||
        !Array.isArray(d.good) ||
        !Array.isArray(d.rises) ||
        !Array.isArray(d.drops) ||
        !d.stats
      ) {
        throw new ApiError(200); // a 200 without the expected shape
      }
      return false;
    },
  );

  if (!slug || (state.status === 'error' && state.error instanceof ApiError && (state.error.status === 404 || state.error.status === 400))) {
    return <NotFound />;
  }
  if (state.status === 'error') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Shop</h1>
        <Notice
          title="This shop could not be loaded."
          action={
            <Button variant="outline" className="min-h-11" onClick={state.retry}>
              Try again
            </Button>
          }
        >
          Check your connection and try again.
        </Notice>
      </div>
    );
  }
  if (state.status !== 'ready') {
    return (
      <div role="status" aria-label="Loading shop" className="flex flex-col gap-6">
        <h1 className="sr-only">Shop</h1>
        <div aria-hidden="true" className="glass h-40 opacity-60" />
        <DealListSkeleton count={3} />
      </div>
    );
  }
  return <ShopContent key={slug} data={state.data} slug={slug} />;
}
