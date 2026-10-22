import { useId, useState } from 'react';
import { Link } from 'react-router';
import { DealList, DealListSkeleton, Notice } from '@/components/site/DealList';
import { FALLBACK_LINE, Headline, parseHighlight } from '@/components/site/Headline';
import { DESKTOP_QUERY } from '@/components/site/nav';
import { LiveSearch } from '@/components/site/SearchBox';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, type ApiState, api, type Card, type HomeResponse, useApi } from '@/lib/api';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { cn } from '@/lib/utils';

const LISTS = {
  good: { title: 'Good deals', none: 'No good deals at the moment.', dot: 'bg-good' },
  avoid: { title: 'Deals to avoid', none: 'No deals to avoid at the moment.', dot: 'bg-bad' },
} as const;
type ListKind = keyof typeof LISTS;

/** Desktop: one section per list, its heading and a See all link above a grid of cards. */
function DealSection({ kind, children }: { kind: ListKind; children: React.ReactNode }) {
  const id = useId();
  const { title, dot } = LISTS[kind];
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={cn('size-2.5 rounded-full', dot)} />
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        <Link
          to={`/deals?type=${kind}`}
          aria-label={`See all ${title.toLowerCase()}`}
          className="ml-auto inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-brand outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          See all
        </Link>
      </div>
      {children}
    </section>
  );
}

function ListOrNone({ kind, cards }: { kind: ListKind; cards: Card[] }) {
  return cards.length > 0 ? <DealList cards={cards} /> : <Notice title={LISTS[kind].none} />;
}

/** Phone: one list at a time with a big Good / Avoid switch. */
function DealTabs({ data }: { data: HomeResponse }) {
  const [tab, setTab] = useState<ListKind>(data.good.length === 0 && data.avoid.length > 0 ? 'avoid' : 'good');
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="sr-only">
        Deals
      </h2>
      <Tabs value={tab} onValueChange={(v) => setTab(v === 'avoid' ? 'avoid' : 'good')} className="gap-3">
        <TabsList className="glass h-auto w-full gap-1 p-1">
          <TabsTrigger value="good" className="min-h-11 rounded-xl font-bold text-muted-foreground data-[state=active]:text-good dark:data-[state=active]:text-good">
            {LISTS.good.title}
          </TabsTrigger>
          <TabsTrigger value="avoid" className="min-h-11 rounded-xl font-bold text-muted-foreground data-[state=active]:text-bad dark:data-[state=active]:text-bad">
            {LISTS.avoid.title}
          </TabsTrigger>
        </TabsList>
        {(['good', 'avoid'] as const).map((kind) => (
          <TabsContent key={kind} value={kind} className="flex flex-col gap-2">
            <ListOrNone kind={kind} cards={data[kind]} />
            <Link
              to={`/deals?type=${kind}`}
              className="inline-flex min-h-11 items-center self-start rounded-md text-sm font-medium text-brand outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              See all {LISTS[kind].title.toLowerCase()}
            </Link>
          </TabsContent>
        ))}
      </Tabs>
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
            <DealSection key={kind} kind={kind}>
              <DealListSkeleton count={3} />
            </DealSection>
          ))
        ) : (
          <>
            <div aria-hidden="true" className="glass h-[54px]" />
            <DealListSkeleton count={3} />
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
          <Button variant="outline" className="min-h-11" onClick={state.retry}>
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
  if (!desktop) return <DealTabs data={data} />;
  return (
    <div className="flex flex-col gap-8">
      {(['good', 'avoid'] as const).map((kind) => (
        <DealSection key={kind} kind={kind}>
          <ListOrNone kind={kind} cards={data[kind]} />
        </DealSection>
      ))}
    </div>
  );
}

const NO_PHRASES = { morning: [], afternoon: [], evening: [], late: [], bfweek: [] };
const FALLBACK_TEXT = parseHighlight(FALLBACK_LINE)
  .map((s) => s.text)
  .join('');

/** Home: the welcome headline (the page's only h1), the search box, then good deals and deals to avoid. */
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
  const [now] = useState(() => new Date());
  const phrases = home.status === 'ready' || home.status === 'empty' ? home.data.phrases : home.status === 'error' ? NO_PHRASES : null;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col items-center gap-3 pt-2 text-center md:pt-6">
        {/* The line is picked from the admin's phrases, so it waits for them. Meanwhile the space is kept
            and a visually hidden fallback h1 keeps the page's one h1. */}
        {phrases ? (
          <Headline phrases={phrases} now={now} />
        ) : (
          <div className="h-9 sm:h-10">
            <h1 className="sr-only">{FALLBACK_TEXT}</h1>
          </div>
        )}
        <p className="text-muted-foreground">Price history from Maltese web shops, to check if a deal is real.</p>
        <LiveSearch className="mt-2" />
      </div>
      <Deals state={home} desktop={desktop} />
    </div>
  );
}
