import { ExternalLink } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { DayTable } from '@/components/site/DayTable';
import { AlarmBanner, avoidFact, avoidKind, BlackFridayMark, NO_PRICE, PriceLine, tagProps } from '@/components/site/DealCard';
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
import { type DayRow, dayRows, lastDays, recentChange } from '@/lib/history';
import { hasWas, SERIES_MAX, seriesStyle, WAS_DASH } from '@/lib/sellerSeries';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { cn } from '@/lib/utils';
import { withSpecs } from '../../../src/site/display.js';
import { maltaDay, type VerdictFacts, wasTerms } from '../../../src/site/verdict.js';

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
    logoUrl: s.logoUrl,
    priceCents: positive(s.priceCents) ? s.priceCents : null,
    wasCents: positive(s.wasCents) ? s.wasCents : null,
    verdict: s.verdict.label,
    reason: s.verdict.reason,
    bf: s.bf,
    category: null,
    raisedFrom: avoid && rf && positive(rf.price) && typeof rf.at === 'string' && DAY.test(rf.at) ? { priceCents: rf.price, at: rf.at } : null,
    wasRaisedFromCents: avoid && positive(f?.wasRaisedFrom) ? f.wasRaisedFrom : null,
    ...(s.wasLabel ? { wasLabel: s.wasLabel } : {}),
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
type Shown = {
  variantId: number | null;
  priceCents: number | null;
  wasCents: number | null;
  inStock: boolean | null;
  checked: boolean;
  /** the Malta day of the variant's newest reading when that is older than the last 30 days: it is not current */
  lastSeen: string | null;
};

/** The days a variant's newest reading may be old and still show as its price (as the old listing page). */
const CURRENT_DAYS = 30;
const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);

function shownFor(s: SellerView, variants: VariantView[], option: string | null, today: string): Shown | null {
  if (option === null) return { variantId: s.productId, priceCents: s.priceCents, wasCents: s.wasCents, inStock: s.inStock, checked: true, lastSeen: null };
  const v = variants.find((x) => x.sellerId === s.id && x.label !== null && optionKey(x.label) === option);
  if (!v) return null;
  const checked = v.id === s.productId;
  const seenDay = !checked && v.seenAt && !Number.isNaN(Date.parse(v.seenAt)) ? maltaDay(new Date(v.seenAt)) : null;
  return {
    variantId: v.id,
    priceCents: checked ? s.priceCents : v.priceCents,
    wasCents: checked ? s.wasCents : null,
    inStock: checked ? s.inStock : v.inStock,
    checked,
    lastSeen: seenDay !== null && dayNumber(today) - dayNumber(seenDay) >= CURRENT_DAYS ? seenDay : null,
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
function NumbersPanel({ title, facts, judged, wasLabel }: { title: string; facts: VerdictFacts; judged: boolean; wasLabel?: string }) {
  const was = wasTerms(wasLabel).start;
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
    [`${was} before its rise`, positive(facts.wasRaisedFrom) ? formatEuro(facts.wasRaisedFrom) : null],
    ['Days tracked', finite(facts.historyDays) ? String(facts.historyDays) : null],
    ['Price changes', finite(facts.priceChanges) ? String(facts.priceChanges) : null],
    [`${was} changes`, finite(facts.wasChanges) ? String(facts.wasChanges) : null],
    ['Days worth buying', judged && finite(facts.daysWorthBuying) && finite(facts.historyDays) ? `${facts.daysWorthBuying} of ${facts.historyDays}` : null],
  ];
  return (
    <Section title={title}>
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

/** Simple: lowest 30 days, usual price and real change, from one seller's stored verdict facts. */
function ThreeNumbers({ shop, facts }: { shop: string; facts: VerdictFacts }) {
  const real = facts.realPct;
  const items: [string, string, string?][] = [
    ['Lowest 30 days', euroOr(facts.low30, 'Not known yet')],
    ['Usual price', euroOr(facts.usual, 'Not known yet')],
    ['Real change', finite(real) ? signedPct(real) : 'Not known yet', finite(real) ? (real > 0 ? 'text-bad' : real < 0 ? 'text-good' : undefined) : undefined],
  ];
  return (
    <ul aria-label={`Price facts at ${shop}`} className="m-0 grid list-none grid-cols-3 gap-2 p-0">
      {items.map(([label, value, tone]) => (
        <li key={label} className="flex flex-col gap-0.5 rounded-xl bg-secondary p-3">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className={cn('text-base font-bold tabular-nums', tone)}>{value}</span>
        </li>
      ))}
    </ul>
  );
}

/** "Price changed from €709.00 to €799.00 on 22 Oct, while marked Black Friday": a rise in the bad colour. */
function PriceChangeLine({ change }: { change: { row: DayRow; from: number } }) {
  return (
    <p className={cn('font-semibold', change.row.price! > change.from ? 'text-bad' : undefined)}>
      Price changed from {formatEuro(change.from)} to {formatEuro(change.row.price!)} on {formatDay(change.row.day)}
      {change.row.bf && ', while marked Black Friday'}
    </p>
  );
}

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
  history,
  raiseWindowDays,
  option,
  factsOpen,
  onToggleFacts,
  selected,
}: {
  seller: SellerView;
  shown: Shown;
  /** the option the seller's verdict is about, when an option is chosen and it is another one */
  verdictOption: string | null;
  cheapest: boolean;
  minHistoryDays: number;
  /** Advanced, several sellers: report this seller as not the same product (target: its site_products row) */
  matchReport: boolean;
  /** this seller's readings (every variant) */
  history: ProductPage['history'];
  /** days back a price change counts as recent (the stored raise window, R43) */
  raiseWindowDays: number;
  /** the seller's option when it sells one (a colour listed on its own) and the product has several */
  option: string | null;
  /** the three numbers are shown for this seller (Simple; one seller at a time) */
  factsOpen: boolean;
  /** opens or closes the three numbers here; null when this seller has none to show (R44: only a judged verdict) */
  onToggleFacts: (() => void) | null;
  /** the listing the visitor came from (?seller=) */
  selected: boolean;
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
  const factsId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const openedHere = useRef(false);
  // the facts the visitor opened get the focus, so the button that opened them does not leave it behind
  useEffect(() => {
    if (factsOpen && openedHere.current) panel.current?.focus();
    openedHere.current = false;
  }, [factsOpen]);
  const priceRise = checked && avoid && avoidKind(base) === 'price';
  // A recent change of the shown variant within the raise window (R43). A price-raise avoid already says it in its
  // tag and fact. Another option of the listing counts from today, so an old price is never called recent.
  const change = useMemo(() => {
    if (shown.variantId === null || shown.lastSeen !== null || !finite(raiseWindowDays) || priceRise) return null;
    const rows = dayRows(history, shown.variantId, null);
    return checked ? recentChange(rows, raiseWindowDays) : recentChange(rows, raiseWindowDays, maltaDay(new Date()));
  }, [history, shown.variantId, shown.lastSeen, raiseWindowDays, checked, priceRise]);
  return (
    <li
      aria-labelledby={titleId}
      data-cheapest={cheapest ? 'true' : undefined}
      data-verdict={checked ? seller.verdict.label : undefined}
      data-alarm={alarm ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      className={cn('glass overflow-hidden', cheapest && 'border-2 border-good', selected && 'border-2 border-brand', alarm && 'border-2 border-bad')}
    >
      {alarm && <AlarmBanner card={base} />}
      <div className={cn('relative flex flex-col gap-1.5 p-4', tag && 'pr-24')}>
        {tag && (
          <div className="absolute top-2 right-4">
            <PriceTag {...tag} size="sm" />
          </div>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ShopBadge name={seller.shop} logoUrl={seller.logoUrl} size="sm" decorative />
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
        {selected && <p className="text-xs font-semibold text-brand">The listing you came from</p>}
        {option && (
          <p data-option className="text-sm font-medium">
            {option}
          </p>
        )}
        {/* the shop's own title stays visible, so a clean name never hides what the shop wrote */}
        <p className="text-xs break-words text-muted-foreground">{seller.title}</p>
        {shown.lastSeen ? (
          <p className="text-lg font-semibold">Last seen on {formatDay(shown.lastSeen)}</p>
        ) : (
          <PriceLine card={card} className="[&>span:first-child]:text-2xl" />
        )}
        {shown.inStock === false && !shown.lastSeen && <p className="text-sm text-muted-foreground">Out of stock</p>}
        {checked && seller.bf && !alarm && <BlackFridayMark />}
        {fact && <p className="font-semibold text-bad">{fact}</p>}
        {change && <PriceChangeLine change={change} />}
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
        {onToggleFacts && (
          <Button
            variant="outline"
            className="min-h-11 w-fit"
            aria-expanded={factsOpen}
            aria-controls={factsId}
            onClick={() => {
              openedHere.current = !factsOpen;
              onToggleFacts();
            }}
          >
            {`${factsOpen ? 'Hide' : 'Show'} the price facts at ${seller.shop}`}
          </Button>
        )}
        <div id={factsId} ref={panel} tabIndex={-1} hidden={!(factsOpen && seller.verdict.facts)} className="rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {factsOpen && seller.verdict.facts && <ThreeNumbers shop={seller.shop} facts={seller.verdict.facts} />}
        </div>
        <div className="flex flex-wrap items-center gap-x-4">
          {shopUrl && (
            <a
              href={shopUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-sm font-semibold text-brand outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
function History({
  data,
  sellers,
  shownBy,
  options,
  start,
}: {
  data: ProductPage;
  sellers: SellerView[];
  shownBy: Map<number, Shown>;
  /** how many options the product has: lines and numbers name theirs when it has several */
  options: number;
  /** the seller whose price by day shows first */
  start: number | null;
}) {
  const [range, setRange] = useState<Range>('30');
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const tableId = useId();
  const headingId = useId();
  const [chosen, setChosen] = useState<number | null>(start);
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
          // seller and option, so two listings of one shop (each colour on its own) are told apart
          const label = variant !== null && (options > 1 || (variantsPer.get(s.id) ?? 0) > 1) ? labelOf.get(variant) : null;
          return { id: s.id, shop: s.shop, legend: label ? `${s.shop} (${label})` : s.shop, rows, wasName: wasTerms(s.wasLabel).inner };
        })
        .filter((l) => l.rows.length > 0)
        .slice(0, SERIES_MAX),
    [sellers, shownBy, data.history, range, variantsPer, labelOf, options],
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
              {lines.map((l, i) =>
                hasWas(l) ? (
                  <li key={`w${l.id}`} className="flex items-center gap-1.5">
                    <svg aria-hidden="true" width="18" height="6" className="flex-none">
                      <line x1="0" y1="3" x2="18" y2="3" stroke={seriesStyle(i).stroke} strokeOpacity="0.6" strokeWidth="1.4" strokeDasharray={WAS_DASH} />
                    </svg>
                    {`${l.legend} ${l.wasName}`}
                  </li>
                ) : null,
              )}
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
          <DayTable id={tableId} rows={rows} judged={judged} low30={low30} wasLabel={seller?.wasLabel} />
        )}
      </div>
      {seller?.verdict.facts && (
        <NumbersPanel
          // the numbers are about the option the verdict checked: say so when another one is chosen
          title={shown && !shown.checked ? `Numbers at ${seller.shop}, for ${labelOf.get(seller.productId ?? -1) ?? 'another option'}` : `Numbers at ${seller.shop}`}
          facts={seller.verdict.facts}
          judged={seller.verdict.label === 'good' || seller.verdict.label === 'avoid'}
          wasLabel={seller.wasLabel}
        />
      )}
    </>
  );
}

function ProductContent({ data, selectedId }: { data: ProductPage; selectedId: number | null }) {
  const { mode } = useMode();
  const advanced = mode === 'advanced';
  const titleId = useId();
  const listId = useId();
  const [option, setOption] = useState<string | null>(null);
  // Simple: the seller whose three numbers are shown, the cheapest by default (one seller at a time)
  const selected = selectedId !== null && data.sellers.some((s) => s.id === selectedId) ? selectedId : null;
  const [factsFor, setFactsFor] = useState<number | null>(selected ?? data.cheapestId);
  // the clock is read once per page view
  const [today] = useState(() => maltaDay(new Date()));
  const [announcement, setAnnouncement] = useState('');
  const { product } = data;

  const options = useMemo(() => optionsOf(data.variants), [data.variants]);
  const shownBy = useMemo(() => {
    const m = new Map<number, Shown>();
    for (const s of data.sellers) {
      const shown = shownFor(s, data.variants, option, today);
      if (shown) m.set(s.id, shown);
    }
    return m;
  }, [data.sellers, data.variants, option, today]);
  const sellers = data.sellers.filter((s) => shownBy.has(s.id));
  const labelOf = (id: number | null) => (id === null ? null : (data.variants.find((v) => v.id === id)?.label ?? null));
  /** R44: only a good or avoid verdict, shown on the variant it is about, has numbers to show */
  const hasFacts = (s: SellerView) => !!s.verdict.facts && (s.verdict.label === 'good' || s.verdict.label === 'avoid') && shownBy.get(s.id)?.checked === true;
  /** a seller's own option, when it sells exactly one (a shop that lists each colour on its own) */
  const ownOption = (s: SellerView) => {
    if (options.length < 2) return null;
    const mine = data.variants.filter((v) => v.sellerId === s.id);
    return mine.length === 1 ? mine[0]!.label : null;
  };

  // the lowest price of a seller not known out of stock, as the search result says it
  const stocked = data.sellers.filter((s) => s.inStock !== false && positive(s.priceCents));
  const lowest = stocked.length > 0 ? Math.min(...stocked.map((s) => s.priceCents as number)) : null;
  // one shop may sell several listings of the product (each colour on its own): count shops, not listings
  const shops = new Set(data.sellers.map((s) => s.shopSlug)).size;
  const summary = shops > 1 ? (lowest !== null ? `from ${formatEuro(lowest)} at ${shops} shops` : `at ${shops} shops`) : `at ${data.sellers[0]!.shop}`;

  const choose = (key: string | null) => {
    setOption(key);
    const label = key === null ? 'All options' : (options.find((o) => o.key === key)?.label ?? '');
    const n = key === null ? data.sellers.length : data.sellers.filter((s) => shownFor(s, data.variants, key, today) !== null).length;
    setAnnouncement(`${label}: ${n} ${n === 1 ? 'shop' : 'shops'}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <article aria-labelledby={titleId} className="glass flex flex-col gap-3 p-4">
        <div className="flex items-start gap-4">
          <ProductImage url={product.imageUrl} alt="" size={96} className="size-24" />
          <div className="flex min-w-0 flex-col gap-1">
            {product.brand && <p className="text-sm text-muted-foreground">{product.brand}</p>}
            <h1 id={titleId} className="text-xl leading-snug font-bold tracking-tight break-words sm:text-2xl">
              {withSpecs(product.name, product.specs)}
            </h1>
            <p className="text-sm text-muted-foreground">{summary}</p>
            {/* one option only (a shop that lists each colour on its own): say which one this is */}
            {options.length === 1 && <p className="text-sm font-medium">{`Option: ${options[0]!.label}`}</p>}
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
              cheapest={option === null && s.id === data.cheapestId && shops > 1}
              minHistoryDays={data.minHistoryDays}
              matchReport={advanced && data.sellers.length > 1}
              history={data.history.filter((h) => h.sellerId === s.id)}
              raiseWindowDays={data.raiseWindowDays}
              option={ownOption(s)}
              factsOpen={!advanced && factsFor === s.id && hasFacts(s)}
              onToggleFacts={!advanced && hasFacts(s) ? () => setFactsFor((cur) => (cur === s.id ? null : s.id)) : null}
              selected={s.id === selected}
            />
          ))}
        </ol>
      </section>

      {advanced && (
        <>
          <History data={data} sellers={sellers} shownBy={shownBy} options={options.length} start={selected ?? data.cheapestId} />
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
  const location = useLocation();
  const [params] = useSearchParams();
  const sellerParam = params.get('seller');
  const selectedId = sellerParam !== null && ID.test(sellerParam) ? Number(sellerParam) : null;
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
    if (canonical) navigate(productPath(canonical) + location.search, { replace: true });
  }, [canonical, navigate, location.search]);

  if (!valid || notFound(state)) return <NotFound />;
  if (state.status === 'error') return <Failed retry={state.retry} />;
  if (state.status !== 'ready') return <Loading />;
  return <ProductContent key={state.data.key} data={state.data} selectedId={selectedId} />;
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
