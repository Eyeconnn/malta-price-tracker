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
  avoid: { title: 'Deals to avoid here', none: 'No deals to avoid at this shop at the moment.' },
  good: { title: 'Good deals here', none: 'No good deals at this shop at the moment.' },
} as const;

function DealSection({ kind, cards, slug }: { kind: keyof typeof LISTS; cards: Card[]; slug: string }) {
  const id = useId();
  const { title, none } = LISTS[kind];
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id={id} className="text-xl font-bold">
          {title}
        </h2>
        {cards.length > 0 && (
          <Link
            to={`/deals?${new URLSearchParams({ type: kind, shop: slug })}`}
            aria-label={`See all ${title.toLowerCase()}`}
            className="ml-auto inline-flex min-h-11 items-center rounded-full px-2 text-sm font-semibold text-brand outline-none hover:text-brand-dark hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
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

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: 'good' | 'bad'; hint?: string }) {
  return (
    <div className="glass flex flex-col gap-1.5 rounded-[14px] px-5 py-[18px]">
      <dt className="t-lbl">{label}</dt>
      <dd className={cn('m-0 t-num text-[32px] leading-[1.15]', /^\d/.test(value) ? undefined : 'font-sans text-base font-semibold', tone === 'good' && 'text-good', tone === 'bad' && 'text-bad')}>{value}</dd>
      {hint && <p className="text-[13px] text-muted-foreground">{hint}</p>}
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
      <dl className="m-0 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Real deals"
          value={real === null || !isCount(real) ? 'Not enough judged yet' : percent(real)}
          hint={isCount(stats.good) && isCount(stats.judged) && stats.judged > 0 ? `${countText(stats.good)} of ${countText(stats.judged)} judged products` : undefined}
        />
        <Stat label="Deals to avoid" value={countText(stats.avoid)} tone={isCount(stats.avoid) && stats.avoid > 0 ? 'bad' : undefined} />
        <Stat label={`${wasTerms(wasLabel).start} raised`} value={countText(stats.wasRaised)} tone={isCount(stats.wasRaised) && stats.wasRaised > 0 ? 'bad' : undefined} />
        <Stat label="Marked Black Friday" value={countText(stats.bfMarked)} hint={isCount(stats.products) ? `of ${countText(stats.products)} products` : undefined} />
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
  if (!shown(cents)) return <td className="text-xs text-muted-foreground">{NO_PRICE}</td>;
  return (
    <td className="tabular-nums">
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
    <div className="glass px-3 py-[18px]">
      {rows.length === 0 ? (
        <div className="px-2.5">
          <p className="text-[17px] font-bold">{caption}</p>
          <p className="mt-2 text-sm text-muted-foreground">{none}</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <caption className="px-2.5 pb-2 text-left text-[17px] font-bold">{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Before</th>
                <th scope="col">Now</th>
                <th scope="col" className="r">
                  Change
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row" className="font-semibold">
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
                    <td className={cn('r font-bold tabular-nums', tone === 'bad' ? 'text-bad' : 'text-good')}>{signed(r.pct)}</td>
                  ) : (
                    <td className="r text-xs text-muted-foreground">{NO_PRICE}</td>
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
    <>
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <Link to="/shops" className="font-medium text-brand hover:underline">
          Shops
        </Link>
        <span aria-hidden="true">/</span>
        <span className="truncate">{shop.name}</span>
      </nav>
      <section className="glass flex flex-wrap items-start gap-x-10 gap-y-6 p-[22px]">
        <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-3.5">
          <div className="flex min-w-0 items-center gap-4">
            <ShopBadge name={shop.name} logoUrl={shop.logoUrl} logoAspect={shop.logoAspect} decorative />
            <div className="flex min-w-0 flex-col gap-0.5">
              <h1 className="min-w-0 text-[26px] leading-tight font-bold tracking-[-0.01em] break-words md:text-[32px]">{shop.name}</h1>
              {isCount(data.stats.products) && <p className="text-sm text-muted-foreground">{`${countText(data.stats.products)} products tracked`}</p>}
            </div>
          </div>
          <LiveSearch shop={slug} placeholder={`Search inside ${shop.name}`} className="max-w-none" />
        </div>
        <div className="flex min-w-[260px] flex-[0_1_380px] flex-col items-start gap-1.5">
          <RatingScale grade={rating.grade} sentence={rating.sentence} className="w-full" />
          <ReportButton targetType="shop" targetId={shop.id} about={shop.name} />
        </div>
      </section>
      {mode === 'advanced' && <StatsBlock stats={data.stats} wasLabel={data.shop.wasLabel} />}
      {mode === 'advanced' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <ChangeTable caption="Top price rises" rows={data.rises} tone="bad" none={`No price rises ${changeWindow}.`} />
          <ChangeTable caption="Top real drops" rows={data.drops} tone="good" none={`No price drops ${changeWindow}.`} />
        </div>
      )}
      <DealSection kind="avoid" cards={data.avoid} slug={slug} />
      <DealSection kind="good" cards={data.good} slug={slug} />
    </>
  );
}

function NotFound() {
  return (
    <GlassCard className="p-6">
      <h1 className="text-[26px] font-bold tracking-tight">Shop not found</h1>
      <p className="mt-2 text-muted-foreground">
        No shop is listed under that address.{' '}
        <Link to="/shops" className="font-semibold text-brand underline underline-offset-4">
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
      <>
        <h1 className="text-[26px] font-bold tracking-tight">Shop</h1>
        <Notice
          title="This shop could not be loaded."
          action={
            <Button variant="outline" onClick={state.retry}>
              Try again
            </Button>
          }
        >
          Check your connection and try again.
        </Notice>
      </>
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
