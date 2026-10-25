import { ChevronDown, ExternalLink, Info, TrendingUp } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { Chip, type ChipTone } from '@/components/site/Chip';
import { DayTable } from '@/components/site/DayTable';
import { AlarmBanner, avoidFact, avoidKind, BlackFridayMark, NO_PRICE, PriceLine, tagProps } from '@/components/site/DealCard';
import { Notice } from '@/components/site/DealList';
import { Fold } from '@/components/site/Fold';
import { GlassCard } from '@/components/site/GlassCard';
import { useMode } from '@/components/site/ModeProvider';
import type { PriceLine as ChartPriceLine } from '@/components/site/PriceChart';
import { PriceTag } from '@/components/site/PriceTag';
import { ProductImage, productPath } from '@/components/site/ProductResult';
import { ReportButton } from '@/components/site/ReportButton';
import { SegmentedControl } from '@/components/site/SegmentedControl';
import { ShopBadge } from '@/components/site/ShopBadge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ApiError, api, type Card, type ProductPage, type SellerView, type VariantView, useApi } from '@/lib/api';
import { formatDay, formatEuro, signedPct } from '@/lib/format';
import { type DayRow, dayRows, lastDays, recentChange } from '@/lib/history';
import { SERIES_MAX } from '@/lib/sellerSeries';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { cn } from '@/lib/utils';
import { SITE_CATEGORIES } from '../../../src/site/categories.js';
import { withSpecs } from '../../../src/site/display.js';
import { maltaDay, type VerdictFacts, wasTerms } from '../../../src/site/verdict.js';

// The chart (and its motion library) is only downloaded when the chart is opened.
const PriceChart = lazy(() => import('@/components/site/PriceChart'));

const RANGES = { '7': 7, '30': 30 } as const;
type Range = keyof typeof RANGES;

const KEY = /^[cs]\d{1,15}$/;
const ID = /^\d{1,15}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const euroOr = (cents: number | null | undefined, none: string) => (positive(cents) ? formatEuro(cents) : none);

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
    logoAspect: s.logoAspect,
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

/** A seller's verdict in a word, for the quiet rows and the advice chip. */
function verdictWord(s: SellerView, shown: Shown): { word: string; tone: ChipTone; text: string } {
  if (!shown.checked) return { word: 'Not checked', tone: 'neutral', text: 'text-muted-foreground' };
  switch (s.verdict.label) {
    case 'good':
      return { word: 'Real deal', tone: 'good', text: 'text-good' };
    case 'avoid':
      return { word: 'Deal to avoid', tone: 'bad', text: 'text-bad' };
    case 'none':
      return { word: 'Regular price', tone: 'neutral', text: 'text-muted-foreground' };
    default:
      return { word: 'Not judged yet', tone: 'neutral', text: 'text-muted-foreground' };
  }
}

const stockText = (shown: Shown) => (shown.lastSeen ? null : shown.inStock === false ? 'Out of stock' : shown.inStock === true ? 'In stock' : null);

/** Advanced: every stored fact behind one seller's verdict. "Days worth buying" only for a judged verdict (R44). */
function NumbersPanel({ title, facts, judged, wasLabel }: { title: string; facts: VerdictFacts; judged: boolean; wasLabel?: string }) {
  const id = useId();
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
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="text-[17px] font-bold">
        {title}
      </h3>
      <dl className="m-0 flex flex-col text-sm">
        {rows
          .filter((r): r is [string, string, string?] => r[1] !== null)
          .map(([label, value, tone]) => (
            <div key={label} className="flex items-baseline justify-between gap-3 border-t border-line py-[7px]">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className={cn('m-0 text-right font-semibold tabular-nums', tone)}>{value}</dd>
            </div>
          ))}
      </dl>
    </section>
  );
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** Lowest 30 days, usual price and real change, from one seller's stored verdict facts. */
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
        <li key={label} className="frost flex flex-col gap-0.5 rounded-xl p-3">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className={cn('t-num text-lg', tone)}>{value}</span>
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

/** "View on <shop>", opening the shop's own page in a new tab. */
function ShopLink({ url, shop, primary = false }: { url: string; shop: string; primary?: boolean }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className={cn(buttonVariants({ variant: primary ? 'default' : 'outline', size: primary ? 'default' : 'sm' }), 'w-fit')}>
      View on {shop}
      <ExternalLink className="size-4" aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * One seller as a quiet row: shop, stock, its verdict in a word and its price. Its details (that shop's own tag
 * and verdict sentence, a recent change, a cheaper shop, its price facts, "View on <shop>" and "Something wrong?")
 * open with the row's Details button, and are always open in Advanced mode. A was price is one shop's claim, so
 * verdicts are never merged.
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
  advanced,
  factsOpen,
  onToggleFacts,
  selected,
  bestPrice,
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
  advanced: boolean;
  /** the three numbers are shown for this seller (Simple; one seller at a time) */
  factsOpen: boolean;
  /** opens or closes the three numbers here; null when this seller has none to show (R44: only a judged verdict) */
  onToggleFacts: (() => void) | null;
  /** the listing the visitor came from (?seller=) */
  selected: boolean;
  /** the advice's price, to say how much more or less this shop asks */
  bestPrice: number | null;
}) {
  const titleId = useId();
  const detailsId = useId();
  const [open, setOpen] = useState(selected);
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
  const word = verdictWord(seller, shown);
  const stock = stockText(shown);
  const detailsOpen = advanced || open;
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
  const diff = bestPrice !== null && positive(card.priceCents) && !shown.lastSeen ? card.priceCents - bestPrice : null;

  return (
    <li
      aria-labelledby={titleId}
      data-cheapest={cheapest ? 'true' : undefined}
      data-verdict={checked ? seller.verdict.label : undefined}
      data-alarm={alarm ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      className="border-t border-line py-3 first:border-t-0"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ShopBadge name={seller.shop} logoUrl={seller.logoUrl} logoAspect={seller.logoAspect} size="sm" decorative />
        <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 id={titleId} className="min-w-0 font-semibold break-words">
              <Link to={`/shops/${encodeURIComponent(seller.shopSlug)}`} className="rounded-sm text-ink outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
                {seller.shop}
              </Link>
            </h3>
            {cheapest && <Chip tone="neutral">Cheapest</Chip>}
          </div>
          {selected && <p className="text-[13px] text-muted-foreground">The listing you came from</p>}
          {option && (
            <p data-option className="text-sm font-medium">
              {option}
            </p>
          )}
        </div>
        {stock && <span className={cn('min-w-24 text-[13px] font-semibold', shown.inStock === false ? 'text-muted-foreground' : 'text-ink')}>{stock}</span>}
        <span className={cn('min-w-32 text-[13px] font-semibold', word.text)}>{word.word}</span>
        <div className="flex min-w-24 flex-col items-end gap-0.5 text-right">
          {shown.lastSeen ? (
            <p className="font-semibold">Last seen on {formatDay(shown.lastSeen)}</p>
          ) : (
            <PriceLine card={card} className="justify-end" priceClassName="text-xl" />
          )}
          {diff !== null && !cheapest && (
            <span className="text-[13px] text-muted-foreground">{diff > 0 ? `${formatEuro(diff)} more` : diff < 0 ? `${formatEuro(-diff)} less` : 'Same price'}</span>
          )}
        </div>
        {!advanced && (
          <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((o) => !o)} className="-mr-2">
            Details
            <ChevronDown aria-hidden="true" className="chev" />
          </Button>
        )}
      </div>
      <Fold open={detailsOpen} id={detailsId}>
        <div className="flex flex-col gap-2 pt-3 sm:pl-11">
          {alarm && <AlarmBanner card={base} />}
          <div className="flex items-start gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {/* the shop's own title stays visible, so a clean name never hides what the shop wrote */}
              <p className="text-[13px] break-words text-muted-foreground">{seller.title}</p>
              {checked && seller.bf && !alarm && <BlackFridayMark />}
              {fact && <p className="text-sm font-semibold text-bad">{fact}</p>}
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
                seller.verdict.reason && <p className="text-sm leading-relaxed">{seller.verdict.reason}</p>
              )}
            </div>
            {tag && <PriceTag {...tag} size="sm" className="mt-1 mr-2" />}
          </div>
          {onToggleFacts && (
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {shopUrl && <ShopLink url={shopUrl} shop={seller.shop} />}
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
      </Fold>
    </li>
  );
}

/**
 * The price chart: a line per seller (each one variant, never a mix), cut to 7 / 30 days, then a "Show price by day"
 * part with one chosen seller's day table and numbers.
 */
function History({
  data,
  sellers,
  shownBy,
  options,
  start,
  open,
}: {
  data: ProductPage;
  sellers: SellerView[];
  shownBy: Map<number, Shown>;
  /** how many options the product has: lines and numbers name theirs when it has several */
  options: number;
  /** the seller whose price by day shows first, and whose line is drawn first */
  start: number | null;
  /** the chart is shown (Advanced, or opened in Simple): until then nothing is drawn */
  open: boolean;
}) {
  const [range, setRange] = useState<Range>('30');
  const [daysOpen, setDaysOpen] = useState(false);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const tableId = useId();
  const headingId = useId();
  const daysId = useId();
  const [chosen, setChosen] = useState<number | null>(start);
  const seller = sellers.find((s) => s.id === chosen) ?? sellers[0];

  const labelOf = useMemo(() => new Map(data.variants.map((v) => [v.id, v.label])), [data.variants]);
  const variantsPer = useMemo(() => {
    const m = new Map<number, number>();
    for (const v of data.variants) m.set(v.sellerId, (m.get(v.sellerId) ?? 0) + 1);
    return m;
  }, [data.variants]);

  // one line per seller, each one variant (the chosen option's, else the verdict's): never a mix of variants; the
  // start seller (the advice's) first, so it is the main line
  const lines = useMemo(() => {
    const ordered = [...sellers].sort((a, b) => Number(b.id === start) - Number(a.id === start));
    return ordered
      .map((s): ChartPriceLine => {
        const variant = shownBy.get(s.id)?.variantId ?? null;
        const rows = variant === null ? [] : lastDays(dayRows(data.history.filter((h) => h.sellerId === s.id), variant, null), RANGES[range]);
        // seller and option, so two listings of one shop (each colour on its own) are told apart
        const label = variant !== null && (options > 1 || (variantsPer.get(s.id) ?? 0) > 1) ? labelOf.get(variant) : null;
        return { id: s.id, legend: label ? `${s.shop} (${label})` : s.shop, rows, wasName: wasTerms(s.wasLabel).inner };
      })
      .filter((l) => l.rows.length > 0)
      .slice(0, SERIES_MAX);
  }, [sellers, start, shownBy, data.history, range, variantsPer, labelOf, options]);

  const shown = seller ? shownBy.get(seller.id) : undefined;
  const variant = shown?.variantId ?? null;
  // only a good / avoid verdict, on the variant it is about, answers "worth buying" (Ruling R44)
  const judged = !!seller && !!shown?.checked && (seller.verdict.label === 'good' || seller.verdict.label === 'avoid');
  const low30 = judged ? (seller!.verdict.facts?.low30 ?? null) : null;
  const rows = useMemo(
    () => (seller && variant !== null ? lastDays(dayRows(data.history.filter((h) => h.sellerId === seller.id), variant, low30), RANGES[range]) : []),
    [seller, variant, data.history, low30, range],
  );
  const best = lines[0]?.legend;

  return (
    <section aria-labelledby={headingId} className="glass flex flex-col gap-4 p-[22px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id={headingId} className="text-[17px] font-bold">
            Price at each shop
          </h2>
          <p className="text-[13px] text-muted-foreground">
            {`Last ${RANGES[range]} days.${best && lines.length > 1 ? ` ${best} is the main line;` : ''} dashed lines are the shops' was prices.`}
          </p>
        </div>
        <SegmentedControl
          label="Chart range"
          items={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
          ]}
          value={range}
          onValueChange={(v) => setRange(v)}
        />
      </div>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No prices tracked in the last 60 days.</p>
      ) : !open ? (
        <div aria-hidden="true" className="min-h-[286px]" />
      ) : (
        <div data-testid="sellers-chart" data-lines={lines.length} className="min-h-[286px]">
          <Suspense fallback={<div aria-hidden="true" className="h-[286px] rounded-xl bg-fill" />}>
            <PriceChart
              lines={lines}
              animate={!reduced}
              label={`Each shop's price over the last ${RANGES[range]} days. Use the left and right arrow keys to read each day; the same prices are in the price by day table.`}
            />
          </Suspense>
          {sellers.filter((s) => (shownBy.get(s.id)?.variantId ?? null) !== null).length > SERIES_MAX && (
            <p className="mt-2 text-xs text-muted-foreground">{`The chart shows the first ${SERIES_MAX} shops of the list.`}</p>
          )}
        </div>
      )}
      <div className="border-t border-line pt-3">
        <Button variant="ghost" size="sm" className="-ml-3.5" aria-expanded={daysOpen} aria-controls={daysId} onClick={() => setDaysOpen((o) => !o)}>
          {daysOpen ? 'Hide price by day' : 'Show price by day'}
          <ChevronDown aria-hidden="true" className="chev" />
        </Button>
        <Fold open={daysOpen} id={daysId}>
          <div className="flex flex-wrap items-start gap-6 pt-3">
            <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-3">
              {sellers.length > 1 && (
                <SegmentedControl
                  label="Shop for the price by day"
                  items={sellers.map((s) => ({ value: String(s.id), label: s.shop }))}
                  value={seller ? String(seller.id) : ''}
                  onValueChange={(v) => setChosen(Number(v))}
                  className="max-w-full"
                />
              )}
              {rows.length === 0 ? (
                <p id={tableId} className="text-sm text-muted-foreground">
                  {seller ? `No prices tracked at ${seller.shop} in the last 60 days.` : 'No prices tracked.'}
                </p>
              ) : (
                <DayTable id={tableId} rows={rows} judged={judged} low30={low30} wasLabel={seller?.wasLabel} className="max-h-[400px] overflow-y-auto" />
              )}
            </div>
            <div className="flex min-w-0 flex-[1_1_260px] flex-col">
              {seller?.verdict.facts ? (
                <NumbersPanel
                  // the numbers are about the option the verdict checked: say so when another one is chosen
                  title={shown && !shown.checked ? `Numbers at ${seller.shop}, for ${labelOf.get(seller.productId ?? -1) ?? 'another option'}` : `Numbers at ${seller.shop}`}
                  facts={seller.verdict.facts}
                  judged={seller.verdict.label === 'good' || seller.verdict.label === 'avoid'}
                  wasLabel={seller.wasLabel}
                />
              ) : (
                seller && <p className="text-[13px] text-muted-foreground">{`Numbers are shown only for a judged deal. ${seller.shop} does not mark this product Black Friday or claim a discount.`}</p>
              )}
            </div>
          </div>
        </Fold>
      </div>
    </section>
  );
}

/**
 * Our advice: where to buy (the cheapest shop not known out of stock, at the chosen option) for how much, its
 * verdict in one chip, its stock and one line of why, and a neutral word on the listing the visitor came from.
 */
function Advice({
  best,
  shown,
  shops,
  cameFrom,
  cameShown,
  minHistoryDays,
  advanced,
  verdictOption,
}: {
  best: SellerView;
  shown: Shown;
  shops: number;
  cameFrom: SellerView | null;
  cameShown: Shown | null;
  minHistoryDays: number;
  advanced: boolean;
  verdictOption: string | null;
}) {
  const id = useId();
  const card: Card = { ...sellerCard(best), priceCents: positive(shown.priceCents) ? shown.priceCents : null, wasCents: positive(shown.wasCents) ? shown.wasCents : null };
  const word = verdictWord(best, shown);
  const stock = stockText(shown);
  const url = webAddress(best.url);
  const tracked = finite(best.verdict.facts?.historyDays) ? best.verdict.facts.historyDays : null;
  const why = !shown.checked
    ? `Our deal check at ${best.shop} is for ${verdictOption ?? 'another option'}.`
    : best.verdict.label === 'insufficient'
      ? `Not enough price history yet to judge a deal. We judge a deal after ${days(minHistoryDays)} of prices${tracked !== null ? `; we have ${days(tracked)} so far` : ''}.`
      : best.verdict.label === 'none'
        ? 'It is not on sale, so this is its regular price.'
        : (best.verdict.reason ?? '');
  const lead = shops > 1 && card.priceCents !== null ? 'The lowest price at any shop we track today. ' : '';
  const title = card.priceCents !== null ? `Buy it at ${best.shop} for ${formatEuro(card.priceCents)}` : `Sold at ${best.shop}`;

  let came: string | null = null;
  if (cameFrom && cameShown && cameFrom.id !== best.id) {
    const p = positive(cameShown.priceCents) ? cameShown.priceCents : null;
    const diff = p !== null && card.priceCents !== null ? p - card.priceCents : null;
    came =
      p === null
        ? `${cameFrom.shop} does not show a price for it.`
        : `${cameFrom.shop} sells it for ${formatEuro(p)}${diff !== null && diff > 0 ? `, ${formatEuro(diff)} more than ${best.shop}` : diff !== null && diff < 0 ? `, ${formatEuro(-diff)} less than ${best.shop}, which is out of stock or not priced` : ''}.`;
    if (cameShown.checked && cameFrom.verdict.label === 'avoid' && cameFrom.verdict.reason) came += ` Its discount is not real: ${cameFrom.verdict.reason}`;
  }

  return (
    <section aria-labelledby={id} className="glass flex flex-col gap-3.5 p-[22px]">
      <p className="t-lbl">Our advice</p>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-[1_1_360px] items-start gap-3.5">
          <ShopBadge name={best.shop} logoUrl={best.logoUrl} logoAspect={best.logoAspect} decorative />
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 id={id} className="text-2xl leading-tight font-bold">
              {title}
            </h2>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <Chip tone={word.tone}>{word.word}</Chip>
              {stock && <span className={cn('font-semibold', shown.inStock === false ? 'text-muted-foreground' : 'text-ink')}>{stock}</span>}
            </p>
            {(lead || why) && <p className="max-w-[620px] text-[15px] text-muted-foreground">{`${lead}${why}`}</p>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2.5">
          {card.priceCents !== null ? (
            <PriceLine card={card} className="justify-end" priceClassName="text-[40px] leading-none" />
          ) : (
            <p className="text-sm font-medium text-muted-foreground">{NO_PRICE}</p>
          )}
          {url && <ShopLink url={url} shop={best.shop} primary />}
          {advanced && best.productId !== null && (
            <ReportButton targetType="product" targetId={best.productId} about={`${best.title} at ${best.shop}`} ariaLabel={`Something wrong with the advice? ${best.shop}`} compact />
          )}
        </div>
      </div>
      {came && (
        <div className="flex items-start gap-3 border-t border-line pt-3.5">
          <Info aria-hidden="true" className="mt-0.5 size-5 flex-none text-muted-foreground" />
          <div className="flex flex-col gap-0.5">
            <p className="font-semibold">About the listing you came from</p>
            <p className="max-w-[720px] text-sm text-muted-foreground">{came}</p>
          </div>
        </div>
      )}
    </section>
  );
}

function Breadcrumb({ category, name }: { category: string | null; name: string }) {
  const cat = SITE_CATEGORIES.find((c) => c.slug === category);
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
      <Link to="/" className="font-medium text-brand hover:underline">
        Search
      </Link>
      {cat && (
        <>
          <span aria-hidden="true">/</span>
          <Link to={`/deals?category=${encodeURIComponent(cat.slug)}`} className="font-medium text-brand hover:underline">
            {cat.name}
          </Link>
        </>
      )}
      <span aria-hidden="true">/</span>
      <span className="max-w-[40ch] truncate">{name}</span>
    </nav>
  );
}

function ProductContent({ data, selectedId }: { data: ProductPage; selectedId: number | null }) {
  const { mode, setMode } = useMode();
  const advanced = mode === 'advanced';
  const titleId = useId();
  const listId = useId();
  const chartId = useId();
  const [option, setOption] = useState<string | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const [chartSeen, setChartSeen] = useState(advanced);
  // Simple: the seller whose three numbers are shown, the cheapest by default (one seller at a time)
  const selected = selectedId !== null && data.sellers.some((s) => s.id === selectedId) ? selectedId : null;
  const [factsFor, setFactsFor] = useState<number | null>(selected ?? data.cheapestId);
  // the clock is read once per page view
  const [today] = useState(() => maltaDay(new Date()));
  const [announcement, setAnnouncement] = useState('');
  const { product } = data;
  const showChart = advanced || chartOpen;
  useEffect(() => {
    if (showChart) setChartSeen(true);
  }, [showChart]);

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

  // the advice: the cheapest shown seller with a current price that is not known out of stock
  const priced = sellers.filter((s) => {
    const sh = shownBy.get(s.id)!;
    return positive(sh.priceCents) && sh.inStock !== false && !sh.lastSeen;
  });
  const best =
    priced.length > 0
      ? priced.reduce((a, b) => ((shownBy.get(b.id)!.priceCents as number) < (shownBy.get(a.id)!.priceCents as number) ? b : a))
      : (sellers[0] ?? data.sellers[0]!);
  const bestShown = shownBy.get(best.id) ?? shownFor(best, data.variants, null, today)!;
  const bestPrice = positive(bestShown.priceCents) ? bestShown.priceCents : null;
  const came = selected !== null ? (data.sellers.find((s) => s.id === selected) ?? null) : null;

  const choose = (key: string | null) => {
    setOption(key);
    const label = key === null ? 'All variants' : (options.find((o) => o.key === key)?.label ?? '');
    const n = key === null ? data.sellers.length : data.sellers.filter((s) => shownFor(s, data.variants, key, today) !== null).length;
    setAnnouncement(`${label}: ${n} ${n === 1 ? 'shop' : 'shops'}`);
  };

  return (
    <>
      <Breadcrumb category={product.category} name={product.name} />

      <article aria-labelledby={titleId} className="glass flex flex-col gap-4 p-[22px]">
        <div className="flex items-start gap-[18px]">
          <ProductImage url={product.imageUrl} alt="" size={112} className="size-20 sm:size-28" />
          <div className="flex min-w-0 flex-col gap-1.5">
            {product.brand && <p className="text-[13px] text-muted-foreground">{product.brand}</p>}
            <h1 id={titleId} className="text-[22px] leading-tight font-bold tracking-[-0.01em] break-words sm:text-[26px]">
              {withSpecs(product.name, product.specs)}
            </h1>
            <p className="text-[15px] text-muted-foreground">{summary}</p>
            {/* one option only (a shop that lists each colour on its own): say which one this is */}
            {options.length === 1 && <p className="text-sm font-medium">{`Variant: ${options[0]!.label}`}</p>}
          </div>
        </div>
        {options.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <p id={`${titleId}-option`} className="ml-[15px] text-[13px] font-semibold text-muted-foreground">
              Variant
            </p>
            <SegmentedControl
              labelledBy={`${titleId}-option`}
              items={[{ value: '__all', label: 'All' }, ...options.map((o) => ({ value: o.key, label: o.label }))]}
              value={option ?? '__all'}
              onValueChange={(v) => choose(v === '__all' ? null : v)}
              className="w-fit max-w-full"
            />
            <div className="opt-note" data-on={option !== null ? 'true' : undefined}>
              <p aria-hidden={option === null ? true : undefined} className="text-[13px] text-muted-foreground">
                Shops that do not name this variant are left out.
              </p>
            </div>
          </div>
        )}
        {/* announced politely when the option changes; always rendered so the change is heard */}
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </article>

      <Advice
        best={best}
        shown={bestShown}
        shops={shops}
        cameFrom={came}
        cameShown={came ? (shownBy.get(came.id) ?? null) : null}
        minHistoryDays={data.minHistoryDays}
        advanced={advanced}
        verdictOption={labelOf(best.productId)}
      />

      <Fold open={showChart} id={chartId} stacked>
        <History data={data} sellers={sellers} shownBy={shownBy} options={options.length} start={best.id} open={chartSeen} />
      </Fold>
      {!advanced && (
        <Button variant="outline" className="self-start" aria-expanded={chartOpen} aria-controls={chartId} onClick={() => setChartOpen((o) => !o)}>
          <TrendingUp aria-hidden="true" />
          {chartOpen ? 'Hide price chart' : 'View price chart'}
        </Button>
      )}

      <section aria-labelledby={listId} className="glass flex flex-col gap-1 px-[22px] py-[18px]">
        <h2 id={listId} className="mb-1 text-[17px] font-bold">
          {data.sellers.length > 1 ? 'Every shop, cheapest first' : 'Where to buy'}
        </h2>
        <ol aria-label="Shops selling this product" className="m-0 flex list-none flex-col p-0">
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
              advanced={advanced}
              factsOpen={!advanced && factsFor === s.id && hasFacts(s)}
              onToggleFacts={!advanced && hasFacts(s) ? () => setFactsFor((cur) => (cur === s.id ? null : s.id)) : null}
              selected={s.id === selected}
              bestPrice={bestPrice}
            />
          ))}
        </ol>
        {!advanced && (
          <Button variant="ghost" size="sm" className="-ml-3.5 self-start" onClick={() => setMode('advanced')}>
            Show how each shop was judged
          </Button>
        )}
      </section>

      {product.attributes.length > 0 && (
        <Fold open={advanced} stacked>
          <ProductDetails attributes={product.attributes} />
        </Fold>
      )}
      <p className="text-center text-[13px] text-muted-foreground">Prices recorded every night from each shop's website.</p>
    </>
  );
}

function ProductDetails({ attributes }: { attributes: ProductPage['product']['attributes'] }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="glass flex flex-col gap-1.5 p-[22px]">
      <h2 id={id} className="text-[17px] font-bold">
        Product details
      </h2>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-8 text-sm">
        {attributes.map((a) => (
          <div key={a.key} className="flex items-baseline justify-between gap-3 border-t border-line py-[7px]">
            <dt className="text-muted-foreground">{a.label}</dt>
            <dd className="m-0 text-right font-semibold break-words">{a.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function NotFound() {
  return (
    <GlassCard className="p-6">
      <h1 className="text-[26px] font-bold tracking-tight">Product not found</h1>
      <p className="mt-2 text-muted-foreground">
        No product is listed under that address.{' '}
        <Link to="/" className="font-semibold text-brand underline underline-offset-4">
          Back to the home page
        </Link>
      </p>
    </GlassCard>
  );
}

function Failed({ retry }: { retry: () => void }) {
  return (
    <>
      <h1 className="text-[26px] font-bold tracking-tight">Product</h1>
      <Notice
        title="This product could not be loaded."
        action={
          <Button variant="outline" onClick={retry}>
            Try again
          </Button>
        }
      >
        Check your connection and try again.
      </Notice>
    </>
  );
}

function Loading() {
  return (
    <div role="status" aria-label="Loading product" className="flex flex-col gap-6">
      <h1 className="sr-only">Product</h1>
      <div aria-hidden="true" className="glass h-48 opacity-60" />
      <div aria-hidden="true" className="glass h-40 opacity-60" />
    </div>
  );
}

const notFound = (state: { status: string; error?: unknown }) =>
  state.status === 'error' && state.error instanceof ApiError && (state.error.status === 404 || state.error.status === 400);

/**
 * A product (design Part 3): its clean name, picture and variants, our advice on where to buy, a price chart
 * (collapsed in Simple, open in Advanced) with the price by day, and every shop that sells it, cheapest first, each
 * with its own verdict. Advanced opens every shop's details and adds the product's attributes.
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
