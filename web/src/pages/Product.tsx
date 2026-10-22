import { Flag } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useId, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { CheaperBox } from '@/components/site/CheaperBox';
import { DayTable } from '@/components/site/DayTable';
import { AlarmBanner, avoidFact, avoidKind, BlackFridayMark, NO_PRICE, PriceLine, tagProps } from '@/components/site/DealCard';
import { Notice } from '@/components/site/DealList';
import { GlassCard } from '@/components/site/GlassCard';
import { useMode } from '@/components/site/ModeProvider';
import { PriceTag } from '@/components/site/PriceTag';
import { ShopBadge } from '@/components/site/ShopBadge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ApiError, api, type Card, type Label, type OtherShop, type ProductResponse, type Variant, useApi } from '@/lib/api';
import { formatDay, formatEuro, signedPct } from '@/lib/format';
import { type DayRow, dayRows, lastDays, recentChange } from '@/lib/history';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { cn } from '@/lib/utils';
import type { VerdictFacts } from '../../../src/site/verdict.js';

// Recharts is only downloaded when an Advanced product page shows the chart.
const PriceChart = lazy(() => import('@/components/site/PriceChart'));

const RANGES = { '7': 7, '30': 30 } as const;
type Range = keyof typeof RANGES;

const ID = /^\d{1,15}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * The product as a deal card, so the tag, alarm banner and change fact are the deal lists' own
 * (Ruling R35): the avoid tag's earlier price comes from facts.raisedFrom / facts.wasRaisedFrom.
 */
export function productCard(d: ProductResponse): Card {
  const p = d.product;
  const f = d.verdict.facts;
  const avoid = d.verdict.label === 'avoid';
  const rf = f?.raisedFrom;
  return {
    id: p.id,
    title: p.title,
    shop: p.shop,
    shopSlug: p.shopSlug,
    priceCents: positive(p.priceCents) ? p.priceCents : null,
    wasCents: positive(p.wasCents) ? p.wasCents : null,
    verdict: d.verdict.label,
    reason: d.verdict.reason,
    bf: p.bf,
    category: p.category,
    raisedFrom: avoid && rf && positive(rf.price) && typeof rf.at === 'string' && DAY.test(rf.at) ? { priceCents: rf.price, at: rf.at } : null,
    wasRaisedFromCents: avoid && positive(f?.wasRaisedFrom) ? f.wasRaisedFrom : null,
  };
}

const euroOr = (cents: number | null | undefined, none: string) => (positive(cents) ? formatEuro(cents) : none);
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

const VERDICT_TEXT: Record<Label, string> = {
  good: 'Real deal',
  avoid: 'Deal to avoid',
  none: 'No deal found',
  insufficient: 'Not enough history',
};

function variantName(v: Variant): string {
  return v.variantTitle || v.title || `Variant ${v.id}`;
}

/** The product the verdict is about, else the first variant, else the newest history point. */
function defaultVariant(d: ProductResponse): number | null {
  return d.product.productId ?? d.variants[0]?.id ?? d.history.at(-1)?.productId ?? null;
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('glass flex flex-col gap-3 p-4', className)}>
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Simple: lowest 30 days, usual price and real change, from the stored facts. */
function ThreeNumbers({ facts }: { facts: VerdictFacts }) {
  const real = facts.realPct;
  const items: [string, string, string?][] = [
    ['Lowest 30 days', euroOr(facts.low30, 'Not known yet')],
    ['Usual price', euroOr(facts.usual, 'Not known yet')],
    ['Real change', finite(real) ? signedPct(real) : 'Not known yet', finite(real) ? (real > 0 ? 'text-bad' : real < 0 ? 'text-good' : undefined) : undefined],
  ];
  return (
    <ul aria-label="Price facts" className="m-0 grid list-none grid-cols-3 gap-2 p-0">
      {items.map(([label, value, tone]) => (
        <li key={label} className="glass flex flex-col gap-0.5 p-3">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className={cn('text-base font-bold tabular-nums sm:text-lg', tone)}>{value}</span>
        </li>
      ))}
    </ul>
  );
}

/** Advanced: every stored fact behind the verdict. "Days worth buying" only for a judged (good / avoid) verdict (R44). */
function NumbersPanel({ facts, judged }: { facts: VerdictFacts; judged: boolean }) {
  const at = (v: { price: number; at: string } | undefined) =>
    v && positive(v.price) && typeof v.at === 'string' && DAY.test(v.at) ? `${formatEuro(v.price)} on ${formatDay(v.at)}` : null;
  const rows: [string, string | null, string?][] = [
    ['Lowest 30 days', euroOr(facts.low30, 'Not known yet')],
    ['Usual price', euroOr(facts.usual, 'Not known yet')],
    ['Claimed discount', finite(facts.claimedPct) ? signedPct(facts.claimedPct) : 'None claimed'],
    [
      'Real change vs lowest 30 days',
      finite(facts.realPct) ? signedPct(facts.realPct) : 'Not known yet',
      finite(facts.realPct) && facts.realPct > 0 ? 'text-bad' : finite(facts.realPct) && facts.realPct < 0 ? 'text-good' : undefined,
    ],
    ['Price before the rise', at(facts.raisedFrom)],
    ['Price after the rise', at(facts.raisedTo), 'text-bad'],
    ['Was price before its rise', positive(facts.wasRaisedFrom) ? formatEuro(facts.wasRaisedFrom) : null],
    ['Days tracked', finite(facts.historyDays) ? String(facts.historyDays) : null],
    ['Price changes', finite(facts.priceChanges) ? String(facts.priceChanges) : null],
    ['Was price changes', finite(facts.wasChanges) ? String(facts.wasChanges) : null],
    ['Days worth buying', judged && finite(facts.daysWorthBuying) && finite(facts.historyDays) ? `${facts.daysWorthBuying} of ${facts.historyDays}` : null],
  ];
  return (
    <Section title="Numbers">
      <dl className="m-0 flex flex-col text-sm">
        {rows
          .filter((r): r is [string, string, string?] => r[1] !== null)
          .map(([label, value, tone]) => (
            <div key={label} className="flex items-baseline justify-between gap-3 border-t border-line py-1.5 first:border-t-0">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className={cn('m-0 text-right font-semibold tabular-nums', tone)}>{value}</dd>
            </div>
          ))}
      </dl>
    </Section>
  );
}

/** Simple: exactly matched other shops only (a title-only match is never shown here). */
function OtherShops({ others }: { others: OtherShop[] }) {
  const exact = others.filter((o) => !o.possible);
  if (exact.length === 0) return null;
  return (
    <Section title="Other shops">
      <ul className="m-0 flex list-none flex-col p-0">
        {exact.map((o) => (
          <li key={o.id} className="border-t border-line first:border-t-0">
            <Link
              to={`/p/${o.id}`}
              className="flex min-h-11 items-center gap-3 rounded-sm py-1.5 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <ShopBadge name={o.shop} size="sm" />
              <span className="min-w-0 flex-1 break-words">{o.shop}</span>
              <span className={cn('tabular-nums', positive(o.priceCents) ? 'font-semibold' : 'text-xs text-muted-foreground')}>
                {euroOr(o.priceCents, NO_PRICE)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Advanced: every other shop's row, title-only matches labelled "possibly the same product". */
function Comparison({ others }: { others: OtherShop[] }) {
  if (others.length === 0) {
    return (
      <Section title="Other shops">
        <p className="text-sm text-muted-foreground">We have not matched this product at another shop.</p>
      </Section>
    );
  }
  return (
    <div className="glass overflow-x-auto p-4">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="pb-2 text-left text-lg font-semibold">Other shops</caption>
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th scope="col" className="px-2 py-1 font-medium">
              Shop
            </th>
            <th scope="col" className="px-2 py-1 text-right font-medium">
              Price
            </th>
            <th scope="col" className="px-2 py-1 font-medium">
              Verdict
            </th>
            <th scope="col" className="px-2 py-1 font-medium">
              Match
            </th>
          </tr>
        </thead>
        <tbody>
          {others.map((o) => (
            <tr key={o.id} className="border-t border-line align-top">
              <th scope="row" className="px-2 py-2 font-medium">
                <Link to={`/p/${o.id}`} className="rounded-sm outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
                  {o.shop}
                </Link>
                <span className="block text-xs font-normal break-words text-muted-foreground">{o.title}</span>
              </th>
              <td className={cn('px-2 py-2 text-right tabular-nums', !positive(o.priceCents) && 'text-xs text-muted-foreground')}>
                {euroOr(o.priceCents, NO_PRICE)}
                {o.inStock === false && <span className="block text-xs text-muted-foreground">Out of stock</span>}
              </td>
              <td className="px-2 py-2">{VERDICT_TEXT[o.verdict] ?? ''}</td>
              <td className="px-2 py-2">
                {o.possible ? (
                  <span className="inline-block rounded-md bg-secondary px-2 py-0.5 text-xs font-semibold">possibly the same product</span>
                ) : (
                  <span className="text-xs text-muted-foreground">Same product</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TOGGLE =
  'min-h-11 rounded-xl px-3 font-semibold text-muted-foreground hover:bg-secondary hover:text-ink data-[state=on]:bg-ink data-[state=on]:text-background data-[state=on]:hover:bg-ink data-[state=on]:hover:text-background';

/** Advanced: the variant the chart and day table show (default: the one the verdict is about). */
function VariantPicker({ variants, value, verdictId, onChange }: { variants: Variant[]; value: number; verdictId: number | null; onChange: (id: number) => void }) {
  const noteId = useId();
  return (
    <Section title="Variants">
      <ToggleGroup
        type="single"
        aria-label="Variant"
        aria-describedby={noteId}
        value={String(value)}
        onValueChange={(v) => {
          if (v) onChange(Number(v));
        }}
        className="glass w-full flex-wrap justify-start gap-1 rounded-2xl p-1"
      >
        {variants.map((v) => (
          <ToggleGroupItem key={v.id} value={String(v.id)} className={cn(TOGGLE, 'h-auto flex-col items-start gap-0 py-1.5 text-left')}>
            <span className="break-words whitespace-normal">{variantName(v)}</span>
            <span className="text-xs font-normal tabular-nums">
              {euroOr(v.priceCents, NO_PRICE)}
              {v.inStock === false && ', out of stock'}
            </span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p id={noteId} className="text-xs text-muted-foreground">
        The chart and the price by day show one variant at a time.
        {verdictId !== null && variants.some((v) => v.id === verdictId) && ` The verdict is about ${variantName(variants.find((v) => v.id === verdictId)!)}.`}
      </p>
    </Section>
  );
}

/** Advanced: chart (lazy Recharts) and day table for one variant, both cut to the 7 / 30 day switch. */
function History({ rows, judged, low30 }: { rows: DayRow[]; judged: boolean; low30: number | null }) {
  const [range, setRange] = useState<Range>('30');
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const tableId = useId();
  const shown = useMemo(() => lastDays(rows, RANGES[range]), [rows, range]);

  return (
    <>
      <section aria-labelledby={`${tableId}-h`} className="glass flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id={`${tableId}-h`} className="text-lg font-semibold">
            Was price vs price
          </h2>
          <ToggleGroup
            type="single"
            aria-label="Chart range"
            value={range}
            onValueChange={(v) => {
              if (v === '7' || v === '30') setRange(v);
            }}
            className="glass ml-auto gap-1 rounded-2xl p-1"
          >
            <ToggleGroupItem value="7" className={TOGGLE}>
              7 days
            </ToggleGroupItem>
            <ToggleGroupItem value="30" className={TOGGLE}>
              30 days
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">No prices tracked for this variant in the last 60 days.</p>
        ) : (
          <>
            <div
              data-testid="price-chart"
              data-points={shown.length}
              role="img"
              aria-label={`Chart of the price and the was price over the last ${RANGES[range]} days. The same prices are in the price by day table.`}
              aria-describedby={tableId}
              className="min-h-[220px]"
            >
              <Suspense fallback={<div aria-hidden="true" className="h-[220px] rounded-xl bg-secondary opacity-60" />}>
                <PriceChart rows={shown} animate={!reduced} />
              </Suspense>
            </div>
            <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground">
              <li className="flex items-center gap-1.5">
                <span aria-hidden="true" className="h-0.5 w-4 bg-brand" />
                Price
              </li>
              <li className="flex items-center gap-1.5">
                <span aria-hidden="true" className="w-4 border-t-2 border-dashed border-muted-foreground" />
                Was price
              </li>
              {judged && (
                <>
                  <li className="flex items-center gap-1.5">
                    <span aria-hidden="true" className="size-3 rounded-sm bg-good/25" />
                    Worth buying
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span aria-hidden="true" className="size-3 rounded-sm bg-bad/25" />
                    Not worth buying
                  </li>
                </>
              )}
            </ul>
          </>
        )}
      </section>
      {shown.length > 0 && (
        <div className="glass p-4">
          <DayTable id={tableId} rows={shown} judged={judged} low30={low30} />
        </div>
      )}
    </>
  );
}

/**
 * "Something wrong?": a placeholder dialog until the report form lands (Task 15). `productId` is the
 * report target, product.productId (products.id of the verdict's variant, Ruling R20).
 */
function SomethingWrong({ productId }: { productId: number | null }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-11 w-fit" data-product-id={productId ?? undefined}>
          <Flag aria-hidden="true" />
          Something wrong?
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Something wrong?</DialogTitle>
          <DialogDescription>Reporting a problem with a product is coming soon. Nothing has been sent.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}

function ProductContent({ data }: { data: ProductResponse }) {
  const { mode } = useMode();
  const advanced = mode === 'advanced';
  const titleId = useId();
  const { product, verdict } = data;
  const facts = verdict.facts;
  const card = productCard(data);
  const tag = tagProps(card);
  const avoid = verdict.label === 'avoid';
  const alarm = avoid && card.bf;
  const verdictId = product.productId;
  const [variant, setVariant] = useState<number | null>(() => defaultVariant(data));

  // Only a good / avoid verdict, on the variant it is about, answers "worth buying" (Ruling R44).
  const verdictJudged = verdict.label === 'good' || verdict.label === 'avoid';
  const judged = verdictJudged && variant !== null && variant === verdictId;

  const verdictRows = useMemo(
    () => (verdictId === null ? [] : dayRows(data.history, verdictId, verdictJudged ? (facts?.low30 ?? null) : null)),
    [data.history, verdictId, facts, verdictJudged],
  );
  const rows = useMemo(
    () => (variant === null ? [] : variant === verdictId ? verdictRows : dayRows(data.history, variant, null)),
    [data.history, variant, verdictId, verdictRows],
  );

  // The insufficient case with a price is "not enough history"; without a price the reason says so.
  const tooNew = verdict.label === 'insufficient' && card.priceCents !== null;
  const trackedDays = finite(facts?.historyDays) ? facts.historyDays : verdictRows.length;
  const fact = avoid ? avoidFact(card) : null;
  // a change is recent within the stored raise window (R43), as the verdict's own price-rise check
  const change =
    (avoid && avoidKind(card) === 'price') || !finite(data.raiseWindowDays) ? null : recentChange(verdictRows, data.raiseWindowDays);

  return (
    <div className="flex flex-col gap-4">
      <article
        aria-labelledby={titleId}
        data-verdict={verdict.label}
        data-alarm={alarm ? 'true' : undefined}
        className={cn('glass overflow-hidden', alarm && 'border-2 border-bad')}
      >
        {alarm && <AlarmBanner card={card} />}
        <div className={cn('relative flex flex-col gap-2 p-4', tag && 'pr-24')}>
          {tag && (
            <div className="absolute top-2 right-4">
              <PriceTag {...tag} />
            </div>
          )}
          <p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <ShopBadge name={product.shop} size="sm" />
            <Link
              to={`/shops/${encodeURIComponent(product.shopSlug)}`}
              className="truncate rounded-sm outline-none hover:text-ink hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {product.shop}
            </Link>
          </p>
          <h1 id={titleId} className="text-xl leading-snug font-bold tracking-tight break-words sm:text-2xl">
            {product.title}
          </h1>
          <PriceLine card={card} className="[&>span:first-child]:text-3xl" />
          {card.bf && !alarm && <BlackFridayMark />}
          {fact && <p className="font-semibold text-bad">{fact}</p>}
          {change && (
            <p className={cn('font-semibold', change.row.price! > change.from ? 'text-bad' : undefined)}>
              Price changed from {formatEuro(change.from)} to {formatEuro(change.row.price!)} on {formatDay(change.row.day)}
              {change.row.bf && ', while marked Black Friday'}
            </p>
          )}
          {tooNew ? (
            <div className="mt-1 flex flex-col gap-1 rounded-xl bg-secondary p-3">
              <p className="font-semibold">Not enough price history yet</p>
              <p className="text-sm">
                {finite(data.minHistoryDays) && `We judge a deal after ${days(data.minHistoryDays)} of prices. `}
                We have {days(trackedDays)} for this product so far.
              </p>
            </div>
          ) : (
            verdict.reason && <p className="text-[15px] leading-relaxed">{verdict.reason}</p>
          )}
        </div>
      </article>

      {data.cheaper && <CheaperBox cheaper={data.cheaper} ownCents={card.priceCents} />}

      {!advanced && facts && !tooNew && <ThreeNumbers facts={facts} />}
      {!advanced && <OtherShops others={data.others} />}

      {advanced && (
        <>
          {data.variants.length > 1 && variant !== null && (
            <VariantPicker variants={data.variants} value={variant} verdictId={verdictId} onChange={setVariant} />
          )}
          <History rows={rows} judged={judged} low30={judged ? (facts?.low30 ?? null) : null} />
          <div className="grid items-start gap-4 lg:grid-cols-2">
            {facts && <NumbersPanel facts={facts} judged={verdictJudged} />}
            <Comparison others={data.others} />
          </div>
        </>
      )}

      <SomethingWrong productId={product.productId} />
    </div>
  );
}

function NotFound() {
  return (
    <GlassCard className="p-6">
      <h1 className="text-2xl font-bold tracking-tight">Product not found</h1>
      <p className="mt-2 text-muted-foreground">
        No product is listed under that address.{' '}
        <Link to="/" className="font-medium text-brand underline underline-offset-4">
          Back to the home page
        </Link>
      </p>
    </GlassCard>
  );
}

/** A product: its tag, verdict and numbers; Advanced adds the chart, price by day, all facts, other shops and variants. */
export function ProductPage() {
  const { id } = useParams();
  const valid = id !== undefined && ID.test(id);
  const state = useApi(
    valid ? id : null,
    (signal) => api.product(Number(id), signal),
    (d) => {
      if (
        !d ||
        !d.product ||
        typeof d.product.title !== 'string' ||
        !d.verdict ||
        !Array.isArray(d.variants) ||
        !Array.isArray(d.history) ||
        !Array.isArray(d.others)
      ) {
        throw new ApiError(200); // a 200 without the expected shape
      }
      return false;
    },
  );

  if (!valid || (state.status === 'error' && state.error instanceof ApiError && (state.error.status === 404 || state.error.status === 400))) {
    return <NotFound />;
  }
  if (state.status === 'error') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Product</h1>
        <Notice
          title="This product could not be loaded."
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
      <div role="status" aria-label="Loading product" className="flex flex-col gap-4">
        <h1 className="sr-only">Product</h1>
        <div aria-hidden="true" className="glass h-48 opacity-60" />
        <div aria-hidden="true" className="glass h-20 opacity-60" />
      </div>
    );
  }
  return <ProductContent key={id} data={state.data} />;
}
