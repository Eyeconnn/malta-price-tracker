import { ExternalLink } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useId, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { DayTable } from '@/components/site/DayTable';
import { AlarmBanner, avoidFact, BlackFridayMark, NO_PRICE, PriceLine, tagProps } from '@/components/site/DealCard';
import { Notice } from '@/components/site/DealList';
import { GlassCard } from '@/components/site/GlassCard';
import { useMode } from '@/components/site/ModeProvider';
import { PriceTag } from '@/components/site/PriceTag';
import { ProductImage, productPath } from '@/components/site/ProductResult';
import { ReportButton } from '@/components/site/ReportButton';
import { ShopBadge } from '@/components/site/ShopBadge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ApiError, api, type Card, type ProductPage, type SellerView, type VariantView, useApi } from '@/lib/api';
import { formatDay, formatEuro, signedPct } from '@/lib/format';
import { dayRows, lastDays } from '@/lib/history';
import { SERIES_MAX, seriesStyle } from '@/lib/sellerSeries';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { cn } from '@/lib/utils';
import { withSpecs } from '../../../src/site/display.js';
import type { VerdictFacts } from '../../../src/site/verdict.js';

// Recharts is only downloaded when an Advanced product page shows the chart.
const SellersChart = lazy(() => import('@/components/site/SellersChart'));

const RANGES = { '7': 7, '30': 30 } as const;
type Range = keyof typeof RANGES;

const KEY = /^[cs]\d{1,15}$/;
const ID = /^\d{1,15}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const euroOr = (cents: number | null | undefined, none: string) => (positive(cents) ? formatEuro(cents) : none);

const TOGGLE =
  'min-h-11 rounded-xl px-3 font-semibold text-muted-foreground hover:bg-secondary hover:text-ink motion-reduce:transition-none data-[state=on]:bg-ink data-[state=on]:text-background data-[state=on]:hover:bg-ink data-[state=on]:hover:text-background';

/** A seller as a deal card, so its tag, alarm and change fact are the deal lists' own (Ruling R35). */
export function sellerCard(s: SellerView): Card {
  const f = s.verdict.facts;
  const avoid = s.verdict.label === 'avoid';
  const rf = f?.raisedFrom;
  return {
    id: s.id,
    title: s.title,
    shop: s.shop,
    shopSlug: s.shopSlug,
    priceCents: positive(s.priceCents) ? s.priceCents : null,
    wasCents: positive(s.wasCents) ? s.wasCents : null,
    verdict: s.verdict.label,
    reason: s.verdict.reason,
    bf: s.bf,
    category: null,
    raisedFrom: avoid && rf && positive(rf.price) && typeof rf.at === 'string' && DAY.test(rf.at) ? { priceCents: rf.price, at: rf.at } : null,
    wasRaisedFromCents: avoid && positive(f?.wasRaisedFrom) ? f.wasRaisedFrom : null,
  };
}

/** The shop's product link, only when it is an http(s) address (the API checks too; scraped data is untrusted). */
function webAddress(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/** The key of an option label: case, spacing and punctuation aside ("Black" and "black" are one option). */
const optionKey = (label: string) => label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

type Option = { key: string; label: string };

/** The options of every seller's variants, each once, in the order they first appear. */
function optionsOf(variants: VariantView[]): Option[] {
  const out = new Map<string, Option>();
  for (const v of variants) {
    if (!v.label) continue;
    const key = optionKey(v.label);
    if (key !== '' && !out.has(key)) out.set(key, { key, label: v.label });
  }
  return [...out.values()];
}

/**
 * What a seller row shows for the chosen option: the seller's variant with that option (its own latest price
 * and stock), or the seller's listing as built (its verdict variant) when no option is chosen. null when the
 * seller does not name the option.
 */
type Shown = { variantId: number | null; priceCents: number | null; wasCents: number | null; inStock: boolean | null; checked: boolean };

function shownFor(s: SellerView, variants: VariantView[], option: string | null): Shown | null {
  if (option === null) return { variantId: s.productId, priceCents: s.priceCents, wasCents: s.wasCents, inStock: s.inStock, checked: true };
  const v = variants.find((x) => x.sellerId === s.id && x.label !== null && optionKey(x.label) === option);
  if (!v) return null;
  const checked = v.id === s.productId;
  return {
    variantId: v.id,
    priceCents: checked ? s.priceCents : v.priceCents,
    wasCents: checked ? s.wasCents : null,
    inStock: checked ? s.inStock : v.inStock,
    checked,
  };
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

/** Advanced: every stored fact behind one seller's verdict. "Days worth buying" only for a judged verdict (R44). */
function NumbersPanel({ shop, facts, judged }: { shop: string; facts: VerdictFacts; judged: boolean }) {
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
    <Section title={`Numbers at ${shop}`}>
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

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/**
 * One seller: shop, price and was price, that shop's own tag and verdict sentence (a was price is one shop's
 * claim, so verdicts are never merged), "View on <shop>" and "Something wrong?". The cheapest seller is marked.
 */
function SellerRow({
  seller,
  shown,
  verdictOption,
  cheapest,
  minHistoryDays,
  matchReport,
}: {
  seller: SellerView;
  shown: Shown;
  /** the option the seller's verdict is about, when an option is chosen and it is another one */
  verdictOption: string | null;
  cheapest: boolean;
  minHistoryDays: number;
  /** Advanced, several sellers: report this seller as not the same product (target: its site_products row) */
  matchReport: boolean;
}) {
  const titleId = useId();
  const base = sellerCard(seller);
  const card: Card = { ...base, priceCents: positive(shown.priceCents) ? shown.priceCents : null, wasCents: positive(shown.wasCents) ? shown.wasCents : null };
  const checked = shown.checked;
  const tag = checked ? tagProps(base) : null;
  const avoid = seller.verdict.label === 'avoid';
  const alarm = checked && avoid && seller.bf;
  const fact = checked && avoid ? avoidFact(base) : null;
  const shopUrl = webAddress(seller.url);
  const tooNew = checked && seller.verdict.label === 'insufficient' && base.priceCents !== null;
  const tracked = finite(seller.verdict.facts?.historyDays) ? seller.verdict.facts.historyDays : null;
  return (
    <li
      aria-labelledby={titleId}
      data-cheapest={cheapest ? 'true' : undefined}
      data-verdict={checked ? seller.verdict.label : undefined}
      className={cn('glass overflow-hidden', cheapest && 'border-2 border-good', alarm && 'border-2 border-bad')}
    >
      {alarm && <AlarmBanner card={base} />}
      <div className={cn('relative flex flex-col gap-1.5 p-4', tag && 'pr-24')}>
        {tag && (
          <div className="absolute top-2 right-4">
            <PriceTag {...tag} size="sm" />
          </div>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ShopBadge name={seller.shop} size="sm" />
          <h3 id={titleId} className="min-w-0 font-semibold break-words">
            <Link
              to={`/shops/${encodeURIComponent(seller.shopSlug)}`}
              className="rounded-sm outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {seller.shop}
            </Link>
          </h3>
          {cheapest && <span className="rounded-full border border-good px-2 py-0.5 text-xs font-bold text-good">Cheapest</span>}
        </div>
        {/* the shop's own title stays visible, so a clean name never hides what the shop wrote */}
        <p className="text-xs break-words text-muted-foreground">{seller.title}</p>
        <PriceLine card={card} className="[&>span:first-child]:text-2xl" />
        {shown.inStock === false && <p className="text-sm text-muted-foreground">Out of stock</p>}
        {checked && seller.bf && !alarm && <BlackFridayMark />}
        {fact && <p className="font-semibold text-bad">{fact}</p>}
        {seller.cheaper && checked && (
          <p className="text-sm font-semibold">
            Cheaper at {seller.cheaper.shop}, <span className="text-good tabular-nums">{formatEuro(seller.cheaper.priceCents)}</span>
          </p>
        )}
        {!checked ? (
          <p className="text-sm text-muted-foreground">{`Our deal check at ${seller.shop} is for ${verdictOption ?? 'another option'}.`}</p>
        ) : tooNew ? (
          <p className="text-sm">
            Not enough price history yet.{finite(minHistoryDays) && ` We judge a deal after ${days(minHistoryDays)} of prices`}
            {tracked !== null && `; we have ${days(tracked)} so far`}.
          </p>
        ) : (
          seller.verdict.reason && <p className="text-[15px] leading-relaxed">{seller.verdict.reason}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-4">
          {shopUrl && (
            <a
              href={shopUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-sm font-semibold text-accent outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              View on {seller.shop}
              <ExternalLink className="size-4" aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
          {/* the report target is the seller's verdict variant, products.id (Ruling R20) */}
          {seller.productId !== null && (
            <ReportButton targetType="product" targetId={seller.productId} about={`${seller.title} at ${seller.shop}`} ariaLabel={`Something wrong? ${seller.shop}`} compact />
          )}
          {matchReport && (
            <ReportButton
              targetType="match"
              targetId={seller.id}
              title="Not the same product?"
              ariaLabel={`Not the same product? Report ${seller.shop}`}
              about={`${seller.title} at ${seller.shop}`}
              compact
            />
          )}
        </div>
      </div>
    </li>
  );
}

/** Advanced: one price line per seller (lazy Recharts), the day table of one chosen seller, both cut to 7 / 30 days. */
function History({ data, sellers, shownBy }: { data: ProductPage; sellers: SellerView[]; shownBy: Map<number, Shown> }) {
  const [range, setRange] = useState<Range>('30');
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const tableId = useId();
  const headingId = useId();
  const [chosen, setChosen] = useState<number | null>(data.cheapestId);
  const seller = sellers.find((s) => s.id === chosen) ?? sellers[0];

  const labelOf = useMemo(() => new Map(data.variants.map((v) => [v.id, v.label])), [data.variants]);
  const variantsPer = useMemo(() => {
    const m = new Map<number, number>();
    for (const v of data.variants) m.set(v.sellerId, (m.get(v.sellerId) ?? 0) + 1);
    return m;
  }, [data.variants]);

  // one line per seller, each one variant (the chosen option's, else the verdict's): never a mix of variants
  const lines = useMemo(
    () =>
      sellers
        .map((s) => {
          const variant = shownBy.get(s.id)?.variantId ?? null;
          const rows = variant === null ? [] : lastDays(dayRows(data.history.filter((h) => h.sellerId === s.id), variant, null), RANGES[range]);
          const label = variant !== null && (variantsPer.get(s.id) ?? 0) > 1 ? labelOf.get(variant) : null;
          return { id: s.id, shop: s.shop, legend: label ? `${s.shop} (${label})` : s.shop, rows };
        })
        .filter((l) => l.rows.length > 0)
        .slice(0, SERIES_MAX),
    [sellers, shownBy, data.history, range, variantsPer, labelOf],
  );

  const shown = seller ? shownBy.get(seller.id) : undefined;
  const variant = shown?.variantId ?? null;
  // only a good / avoid verdict, on the variant it is about, answers "worth buying" (Ruling R44)
  const judged = !!seller && !!shown?.checked && (seller.verdict.label === 'good' || seller.verdict.label === 'avoid');
  const low30 = judged ? (seller!.verdict.facts?.low30 ?? null) : null;
  const rows = useMemo(
    () => (seller && variant !== null ? lastDays(dayRows(data.history.filter((h) => h.sellerId === seller.id), variant, low30), RANGES[range]) : []),
    [seller, variant, data.history, low30, range],
  );

  return (
    <>
      <section aria-labelledby={headingId} className="glass flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id={headingId} className="text-lg font-semibold">
            Price at each shop
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
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No prices tracked in the last 60 days.</p>
        ) : (
          <>
            <div
              data-testid="sellers-chart"
              data-lines={lines.length}
              role="img"
              aria-label={`Chart of each shop's price over the last ${RANGES[range]} days. The prices are in the price by day table, one shop at a time.`}
              aria-describedby={tableId}
              className="min-h-[240px]"
            >
              <Suspense fallback={<div aria-hidden="true" className="h-[240px] rounded-xl bg-secondary opacity-60" />}>
                <SellersChart lines={lines.map((l) => ({ id: l.id, shop: l.shop, rows: l.rows }))} animate={!reduced} />
              </Suspense>
            </div>
            <ul aria-label="Chart lines" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground">
              {lines.map((l, i) => {
                const { stroke, dash } = seriesStyle(i);
                return (
                  <li key={l.id} className="flex items-center gap-1.5">
                    <svg aria-hidden="true" width="18" height="6" className="flex-none">
                      <line x1="0" y1="3" x2="18" y2="3" stroke={stroke} strokeWidth="2.4" strokeDasharray={dash || undefined} />
                    </svg>
                    {l.legend}
                  </li>
                );
              })}
            </ul>
            {sellers.filter((s) => (shownBy.get(s.id)?.variantId ?? null) !== null).length > SERIES_MAX && (
              <p className="text-xs text-muted-foreground">{`The chart shows the first ${SERIES_MAX} shops of the list.`}</p>
            )}
          </>
        )}
      </section>
      <div className="glass flex flex-col gap-3 p-4">
        {sellers.length > 1 && (
          <ToggleGroup
            type="single"
            aria-label="Shop for the price by day"
            value={seller ? String(seller.id) : ''}
            onValueChange={(v) => {
              if (v) setChosen(Number(v));
            }}
            className="glass w-full flex-wrap justify-start gap-1 rounded-2xl p-1"
          >
            {sellers.map((s) => (
              <ToggleGroupItem key={s.id} value={String(s.id)} className={TOGGLE}>
                {s.shop}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        {rows.length === 0 ? (
          <p id={tableId} className="text-sm text-muted-foreground">
            {seller ? `No prices tracked at ${seller.shop} in the last 60 days.` : 'No prices tracked.'}
          </p>
        ) : (
          <DayTable id={tableId} rows={rows} judged={judged} low30={low30} />
        )}
      </div>
      {seller?.verdict.facts && <NumbersPanel shop={seller.shop} facts={seller.verdict.facts} judged={seller.verdict.label === 'good' || seller.verdict.label === 'avoid'} />}
    </>
  );
}

function ProductContent({ data }: { data: ProductPage }) {
  const { mode } = useMode();
  const advanced = mode === 'advanced';
  const titleId = useId();
  const listId = useId();
  const [option, setOption] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const { product } = data;

  const options = useMemo(() => optionsOf(data.variants), [data.variants]);
  const shownBy = useMemo(() => {
    const m = new Map<number, Shown>();
    for (const s of data.sellers) {
      const shown = shownFor(s, data.variants, option);
      if (shown) m.set(s.id, shown);
    }
    return m;
  }, [data.sellers, data.variants, option]);
  const sellers = data.sellers.filter((s) => shownBy.has(s.id));
  const labelOf = (id: number | null) => (id === null ? null : (data.variants.find((v) => v.id === id)?.label ?? null));

  // the lowest price of a seller not known out of stock, as the search result says it
  const stocked = data.sellers.filter((s) => s.inStock !== false && positive(s.priceCents));
  const lowest = stocked.length > 0 ? Math.min(...stocked.map((s) => s.priceCents as number)) : null;
  const summary =
    data.sellers.length > 1
      ? lowest !== null
        ? `from ${formatEuro(lowest)} at ${data.sellers.length} shops`
        : `at ${data.sellers.length} shops`
      : `at ${data.sellers[0]!.shop}`;

  const choose = (key: string | null) => {
    setOption(key);
    const label = key === null ? 'All options' : (options.find((o) => o.key === key)?.label ?? '');
    const n = key === null ? data.sellers.length : data.sellers.filter((s) => shownFor(s, data.variants, key) !== null).length;
    setAnnouncement(`${label}: ${n} ${n === 1 ? 'shop' : 'shops'}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <article aria-labelledby={titleId} className="glass flex flex-col gap-3 p-4">
        <div className="flex items-start gap-4">
          <ProductImage url={product.imageUrl} className="size-24" />
          <div className="flex min-w-0 flex-col gap-1">
            {product.brand && <p className="text-sm text-muted-foreground">{product.brand}</p>}
            <h1 id={titleId} className="text-xl leading-snug font-bold tracking-tight break-words sm:text-2xl">
              {withSpecs(product.name, product.specs)}
            </h1>
            <p className="text-sm text-muted-foreground">{summary}</p>
          </div>
        </div>
        {options.length > 1 && (
          <div className="flex flex-col gap-1">
            <p id={`${titleId}-option`} className="text-xs font-medium text-muted-foreground">
              Option
            </p>
            <ToggleGroup
              type="single"
              aria-labelledby={`${titleId}-option`}
              value={option ?? '__all'}
              onValueChange={(v) => {
                if (v) choose(v === '__all' ? null : v);
              }}
              className="glass w-full flex-wrap justify-start gap-1 rounded-2xl p-1"
            >
              <ToggleGroupItem value="__all" className={TOGGLE}>
                All
              </ToggleGroupItem>
              {options.map((o) => (
                <ToggleGroupItem key={o.key} value={o.key} className={TOGGLE}>
                  {o.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {option !== null && <p className="text-xs text-muted-foreground">Shops that do not name this option are left out.</p>}
          </div>
        )}
        {/* announced politely when the option changes; always rendered so the change is heard */}
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </article>

      <section aria-labelledby={listId} className="flex flex-col gap-3">
        <h2 id={listId} className="text-lg font-semibold">
          {data.sellers.length > 1 ? 'Where to buy, cheapest first' : 'Where to buy'}
        </h2>
        <ol aria-label="Shops selling this product" className="m-0 flex list-none flex-col gap-3 p-0">
          {sellers.map((s) => (
            <SellerRow
              key={s.id}
              seller={s}
              shown={shownBy.get(s.id)!}
              verdictOption={labelOf(s.productId)}
              cheapest={option === null && s.id === data.cheapestId && data.sellers.length > 1}
              minHistoryDays={data.minHistoryDays}
              matchReport={advanced && data.sellers.length > 1}
            />
          ))}
        </ol>
      </section>

      {advanced && (
        <>
          <History data={data} sellers={sellers} shownBy={shownBy} />
          {product.attributes.length > 0 && (
            <Section title="Product details">
              <dl className="m-0 flex flex-col text-sm">
                {product.attributes.map((a) => (
                  <div key={a.key} className="flex items-baseline justify-between gap-3 border-t border-line py-1.5 first:border-t-0">
                    <dt className="text-muted-foreground">{a.label}</dt>
                    <dd className="m-0 text-right font-semibold break-words">{a.value}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}
        </>
      )}
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

function Failed({ retry }: { retry: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight">Product</h1>
      <Notice
        title="This product could not be loaded."
        action={
          <Button variant="outline" className="min-h-11" onClick={retry}>
            Try again
          </Button>
        }
      >
        Check your connection and try again.
      </Notice>
    </div>
  );
}

function Loading() {
  return (
    <div role="status" aria-label="Loading product" className="flex flex-col gap-4">
      <h1 className="sr-only">Product</h1>
      <div aria-hidden="true" className="glass h-48 opacity-60" />
      <div aria-hidden="true" className="glass h-20 opacity-60" />
    </div>
  );
}

const notFound = (state: { status: string; error?: unknown }) =>
  state.status === 'error' && state.error instanceof ApiError && (state.error.status === 404 || state.error.status === 400);

/**
 * A product (design Part 3): its clean name, picture and options, and every shop that sells it, cheapest first,
 * each with its own verdict. Advanced adds a price line per shop, the price by day of one shop, its numbers and
 * the product's attributes.
 */
export function ProductPage() {
  const { key } = useParams();
  const navigate = useNavigate();
  const valid = key !== undefined && KEY.test(key);
  const state = useApi(
    valid ? key : null,
    (signal) => api.productPage(key!, signal),
    (d) => {
      if (!d || typeof d.key !== 'string' || !d.product || typeof d.product.name !== 'string' || !Array.isArray(d.sellers) || d.sellers.length === 0 || !Array.isArray(d.variants) || !Array.isArray(d.history)) {
        throw new ApiError(200); // a 200 without the expected shape
      }
      return false;
    },
  );
  // a listing of a matched product answers with the product's own key: that is the address to keep
  const canonical = state.status === 'ready' && KEY.test(state.data.key) && state.data.key !== key ? state.data.key : null;
  useEffect(() => {
    if (canonical) navigate(productPath(canonical), { replace: true });
  }, [canonical, navigate]);

  if (!valid || notFound(state)) return <NotFound />;
  if (state.status === 'error') return <Failed retry={state.retry} />;
  if (state.status !== 'ready') return <Loading />;
  return <ProductContent key={state.data.key} data={state.data} />;
}

/** An old listing link (/p/:id): goes to its product's page, replacing the address, so old links keep working. */
export function ListingRedirect() {
  const { id } = useParams();
  const valid = id !== undefined && ID.test(id);
  const state = useApi(
    valid ? id : null,
    (signal) => api.product(Number(id), signal),
    (d) => {
      if (!d || !d.product || typeof d.product.key !== 'string' || !KEY.test(d.product.key)) throw new ApiError(200);
      return false;
    },
  );
  if (!valid || notFound(state)) return <NotFound />;
  if (state.status === 'error') return <Failed retry={state.retry} />;
  if (state.status !== 'ready') return <Loading />;
  return <Navigate to={productPath(state.data.product.key)} replace />;
}
