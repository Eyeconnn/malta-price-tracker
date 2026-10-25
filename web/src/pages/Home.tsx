import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Chip } from '@/components/site/Chip';
import { DealDeck, PageMarkers, PauseButton, useDeck } from '@/components/site/DealDeck';
import { DealListSkeleton, Notice } from '@/components/site/DealList';
import { FALLBACK_LINE, Headline, parseHighlight } from '@/components/site/Headline';
import { DESKTOP_QUERY, HOW_WE_CHECK } from '@/components/site/nav';
import { LiveSearch } from '@/components/site/SearchBox';
import { SegmentedControl } from '@/components/site/SegmentedControl';
import { Button } from '@/components/ui/button';
import { ApiError, type ApiState, api, type Card, type HomeResponse, useApi } from '@/lib/api';
import { nextExample } from '@/lib/searchExamples';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { REDUCED_MOTION_QUERY } from '@/lib/useTypingPlaceholder';
import { cn } from '@/lib/utils';
import { DEFAULT_SETTINGS, type Thresholds } from '../../../src/site/settings.js';

const LISTS = {
  good: { title: 'Good deals', none: 'No good deals at the moment.', tone: 'good' as const },
  avoid: { title: 'Deals to avoid', none: 'No deals to avoid at the moment.', tone: 'bad' as const },
} as const;
type ListKind = keyof typeof LISTS;

const seeAll =
  'inline-flex min-h-11 items-center rounded-full px-2 text-sm font-semibold text-brand outline-none hover:text-brand-dark hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** Desktop: one row per list, its heading, See all and the rotation controls above three cards. */
function DealRow({ kind, cards }: { kind: ListKind; cards: Card[] }) {
  const id = useId();
  const { title, none } = LISTS[kind];
  const deck = useDeck(cards.length);
  const lower = title.toLowerCase();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="text-xl font-bold">
          {title}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/deals?type=${kind}`} aria-label={`See all ${lower}`} className={seeAll}>
            See all
          </Link>
          {deck.pages > 1 && (
            <>
              {!deck.reduced && <PauseButton paused={deck.paused} onToggle={() => deck.setPaused((p) => !p)} what={lower} />}
              <Button variant="outline" size="icon" aria-label={`Previous ${lower}`} onClick={() => deck.go(-1)}>
                <ChevronLeft aria-hidden="true" className="size-[18px]" />
              </Button>
              <PageMarkers page={deck.page} pages={deck.pages} />
              <Button variant="outline" size="icon" aria-label={`Next ${lower}`} onClick={() => deck.go(1)}>
                <ChevronRight aria-hidden="true" className="size-[18px]" />
              </Button>
            </>
          )}
        </div>
      </div>
      {cards.length > 0 ? <DealDeck cards={cards} deck={deck} className="pt-5" /> : <Notice title={none} />}
    </section>
  );
}

/** Phone: one list at a time with a Good / Avoid switch, its own pause button and set markers. */
function PhoneDeals({ data }: { data: HomeResponse }) {
  const [tab, setTab] = useState<ListKind>(data.good.length === 0 && data.avoid.length > 0 ? 'avoid' : 'good');
  const id = useId();
  const cards = data[tab];
  const deck = useDeck(cards.length);
  const lower = LISTS[tab].title.toLowerCase();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="sr-only">
        Deals
      </h2>
      <SegmentedControl
        stretch
        label="Deal type"
        items={[
          { value: 'good', label: LISTS.good.title, tone: 'good' },
          { value: 'avoid', label: LISTS.avoid.title, tone: 'bad' },
        ]}
        value={tab}
        onValueChange={setTab}
      />
      {deck.pages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <PageMarkers page={deck.page} pages={deck.pages} />
          {!deck.reduced && <PauseButton paused={deck.paused} onToggle={() => deck.setPaused((p) => !p)} what={lower} />}
        </div>
      )}
      <div role="tabpanel" aria-label={LISTS[tab].title}>
        {cards.length > 0 ? <DealDeck key={tab} cards={cards} deck={deck} className="pt-5" /> : <Notice title={LISTS[tab].none} />}
      </div>
      <Link to={`/deals?type=${tab}`} className={cn(seeAll, 'self-start px-0')}>
        See all {lower}
      </Link>
    </section>
  );
}

function Deals({ state, desktop }: { state: ApiState<HomeResponse> & { retry: () => void }; desktop: boolean }) {
  if (state.status === 'idle' || state.status === 'loading') {
    // the same frame as the loaded lists, so the page barely moves when they arrive
    return (
      <div role="status" aria-label="Loading deals" className="flex flex-col gap-8">
        {desktop ? (
          (['good', 'avoid'] as const).map((kind) => (
            <section key={kind} className="flex flex-col gap-3">
              <h2 className="text-xl font-bold">{LISTS[kind].title}</h2>
              <DealListSkeleton count={3} className="pt-5" />
            </section>
          ))
        ) : (
          <>
            <div aria-hidden="true" className="glass h-12 rounded-full" />
            <DealListSkeleton count={2} className="pt-5" />
          </>
        )}
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <Notice
        title="Prices could not be loaded."
        action={
          <Button variant="outline" onClick={state.retry}>
            Try again
          </Button>
        }
      >
        Check your connection and try again.
      </Notice>
    );
  }
  if (state.status === 'empty') {
    return (
      <Notice title="No deals judged yet.">
        We need {state.data.minHistoryDays} days of prices before we judge a deal. Until then, search a product to see its price.
      </Notice>
    );
  }
  const { data } = state;
  if (!desktop) return <PhoneDeals data={data} />;
  return (
    <div className="flex flex-col gap-8">
      {(['good', 'avoid'] as const).map((kind) => (
        <DealRow key={kind} kind={kind} cards={data[kind]} />
      ))}
    </div>
  );
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** A short version of How we check, with the stored thresholds. */
function HowWeCheckCard() {
  const id = useId();
  const state = useApi('thresholds', (signal) => api.thresholds(signal));
  const t: Thresholds = state.status === 'ready' && state.data?.thresholds ? state.data.thresholds : DEFAULT_SETTINGS.thresholds;
  const items: [string, string, string][] = [
    ['History', `We judge a deal after ${days(t.minHistoryDays)} of prices.`, 'Before that it says "Not enough history yet".'],
    [
      'Deal to avoid',
      `The price or was price rose more than ${t.raisePct}% in the last ${days(t.raiseWindowDays)}.`,
      `Or the was price is higher than any price charged in ${days(t.baselineDays)}.`,
    ],
    ['Good deal', `At least ${t.goodDropPct}% below its lowest price of the previous ${days(t.baselineDays)}.`, 'And the was price was not raised in that time.'],
    ['Cheaper elsewhere', `The same product is at least ${t.cheaperPct}% cheaper at another shop today.`, 'Only for exact matches by barcode or part number.'],
  ];
  return (
    <section aria-labelledby={id} className="glass flex flex-col gap-4 p-[22px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="text-xl font-bold">
          How we check a deal
        </h2>
        <Link to={HOW_WE_CHECK.to} className={seeAll}>
          Read the full rules
        </Link>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(([label, line, hint]) => (
          <div key={label} className="flex flex-col gap-1.5">
            <span className="t-lbl">{label}</span>
            <p className="font-semibold">{line}</p>
            <p className="text-[13px] leading-[18px] text-muted-foreground">{hint}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const NO_PHRASES = { morning: [], afternoon: [], evening: [], late: [], bfweek: [] };
const FALLBACK_TEXT = parseHighlight(FALLBACK_LINE)
  .map((s) => s.text)
  .join('');

/** Five example searches from different categories, picked once per visit. */
function useTryExamples(): string[] {
  return useMemo(() => {
    const out: string[] = [];
    let prev: ReturnType<typeof nextExample> | null = null;
    for (let i = 0; i < 5; i++) {
      prev = nextExample(prev?.category ?? null);
      out.push(prev.text);
    }
    return out;
  }, []);
}

/**
 * Home: the first screen is only the search (the welcome headline, the page's only h1, a muted line, the live
 * search and "Try" examples) with a cue to scroll; below the fold the good deals and deals to avoid, then a short
 * How we check card.
 */
export function HomePage() {
  const home = useApi(
    'home',
    (signal) => api.home(signal),
    (d) => {
      if (!Array.isArray(d?.good) || !Array.isArray(d?.avoid)) throw new ApiError(200); // a 200 without the expected shape
      return d.good.length === 0 && d.avoid.length === 0;
    },
  );
  const desktop = useMediaQuery(DESKTOP_QUERY, true);
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY);
  const [now] = useState(() => new Date());
  const [query, setQuery] = useState('');
  const hero = useRef<HTMLElement>(null);
  const examples = useTryExamples();
  const phrases = home.status === 'ready' || home.status === 'empty' ? home.data.phrases : home.status === 'error' ? NO_PHRASES : null;
  const headingId = useId();

  const pick = (text: string) => {
    setQuery(text);
    hero.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  };

  return (
    <>
      <section ref={hero} aria-labelledby={headingId} data-testid="home-hero" className="hero relative flex flex-col items-center justify-center gap-3.5 text-center">
        {/* The line is picked from the admin's phrases, so it waits for them. Meanwhile the space is kept
            and a visually hidden fallback h1 keeps the page's one h1. */}
        <div id={headingId}>
          {phrases ? (
            <Headline phrases={phrases} now={now} />
          ) : (
            <div className="h-[34px] sm:h-[57px]">
              <h1 className="sr-only">{FALLBACK_TEXT}</h1>
            </div>
          )}
        </div>
        <p className="text-[17px] text-muted-foreground">Price history from Maltese web shops, to check if a deal is real.</p>
        <LiveSearch animated value={query} onValueChange={setQuery} className="mt-2.5 max-w-[760px]" />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="text-[13px] text-muted-foreground">Try:</span>
          {examples.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => pick(e)}
              className="frost inline-flex min-h-10 items-center rounded-full px-3.5 text-[13px] font-semibold text-muted-foreground outline-none hover:border-ink hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {e}
            </button>
          ))}
        </div>
        <a
          href="#deals"
          onClick={(e) => {
            e.preventDefault();
            const target = document.getElementById('deals');
            target?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
            target?.focus({ preventScroll: true });
          }}
          className="scroll-cue absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-2.5 rounded-2xl text-[13px] font-semibold whitespace-nowrap text-muted-foreground no-underline outline-none hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="inline-flex gap-1.5">
            <Chip tone="good">Good deals</Chip>
            <Chip tone="bad">Deals to avoid</Chip>
          </span>
          <span>Scroll to see this week's verdicts</span>
          <span
            aria-hidden="true"
            className="scroll-cue-icon relative inline-flex size-12 items-center justify-center rounded-full border border-glass-edge bg-glass text-ink shadow-(--shadow-button) backdrop-blur-md"
          >
            <ChevronDown className="size-5" strokeWidth={2.2} />
          </span>
        </a>
      </section>
      <div id="deals" tabIndex={-1} className="outline-none">
        <Deals state={home} desktop={desktop} />
      </div>
      <HowWeCheckCard />
    </>
  );
}
