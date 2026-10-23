import { Search } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { alarmText, avoidSummary, BlackFridayMark, NO_PRICE } from '@/components/site/DealCard';
import { Button } from '@/components/ui/button';
import { ApiError, type ApiState, api, type GroupResult, type SearchResponse, useApi, useDebounced } from '@/lib/api';
import { formatEuro } from '@/lib/format';
import { staticExample } from '@/lib/searchExamples';
import { cn } from '@/lib/utils';
import { useTypingPlaceholder } from '@/lib/useTypingPlaceholder';

/** Same limits as the server (web/worker/api.ts searchPattern). */
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 120;
export const SEARCH_DEBOUNCE_MS = 250;

const length = (s: string) => Array.from(s).length;

/** The path of the search page for a query, optionally limited to one shop (its slug). */
export function searchPath(q: string, shop: string | null = null): string {
  const query = q.trim();
  if (!query) return shop ? `/search?${new URLSearchParams({ shop })}` : '/search';
  return `/search?${new URLSearchParams(shop ? { q: query, shop } : { q: query })}`;
}

/**
 * Searches `query` 250 ms after the typing stops. Under 2 characters nothing is loaded (state
 * 'idle'), and that applies at once, without waiting for the debounce. A newer query aborts the
 * request of the older one (useApi), so a late answer for old text is never shown.
 */
export function useSearch(query: string, shop: string | null = null) {
  const now = query.trim();
  const settled = useDebounced(now, SEARCH_DEBOUNCE_MS);
  const term = length(now) >= SEARCH_MIN && length(settled) >= SEARCH_MIN ? settled : null;
  const state = useApi<SearchResponse>(
    term === null ? null : JSON.stringify([term, shop]),
    (signal) => api.search(term!, shop, signal),
    (d) => {
      if (!Array.isArray(d?.results)) throw new ApiError(200); // a 200 without the expected shape
      return d.results.length === 0;
    },
  );
  return { term, state };
}

/** What the search status announces for a state: empty while idle. */
export function searchStatusText(state: ApiState<SearchResponse>, term: string | null): string {
  switch (state.status) {
    case 'loading':
      return 'Searching';
    case 'ready':
      return state.data.results.length === 1 ? '1 product found' : `${state.data.results.length} products found`;
    case 'empty':
      return `No products match "${term ?? ''}"`;
    case 'error':
      return 'Search is not available right now';
    default:
      return '';
  }
}

/**
 * The one live region for search: always rendered (also before any results), so screen readers
 * hear every change of its text.
 */
export function SearchStatus({ state, term }: { state: ApiState<SearchResponse>; term: string | null }) {
  return (
    <p role="status" data-testid="search-status" className="sr-only">
      {searchStatusText(state, term)}
    </p>
  );
}

export type SearchBoxProps = {
  value: string;
  onChange: (value: string) => void;
  /** Enter or the Check button; gets the trimmed text */
  onSubmit: (value: string) => void;
  /** replaces "Search a product" (the label and the placeholder), e.g. for a search inside one shop */
  placeholder?: string;
  /**
   * Types example products over the empty field instead of a static placeholder (main search only).
   * The label stays "Search a product"; the overlay is aria-hidden, so nothing is announced. While the
   * field has focus the typing stops and one still example stays as the (muted) placeholder.
   */
  animated?: boolean;
  className?: string;
};

/** The big search field with its Check button. */
export function SearchBox({ value, onChange, onSubmit, placeholder = 'Search a product', animated = false, className }: SearchBoxProps) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const showExample = animated && !focused && value === '';
  // while the empty field has focus (the overlay focuses it at once) a still example stays as the placeholder
  const [still] = useState(() => staticExample());
  const { text, caret } = useTypingPlaceholder(showExample);
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value.trim());
      }}
      className={cn('glass flex items-center gap-2 rounded-full p-1.5 pl-4 focus-within:ring-[3px] focus-within:ring-ring/50', className)}
    >
      <label htmlFor={id} className="sr-only">
        {placeholder}
      </label>
      <Search aria-hidden="true" className="size-5 flex-none text-muted-foreground" />
      <div className="relative min-w-0 flex-1">
        <input
          id={id}
          type="search"
          value={value}
          maxLength={SEARCH_MAX}
          autoComplete="off"
          enterKeyHint="search"
          placeholder={animated ? (focused ? still : undefined) : placeholder}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="min-h-11 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        />
        {showExample && (
          <span
            aria-hidden="true"
            data-testid="search-example"
            className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre text-base text-muted-foreground"
          >
            <span className="min-w-0 truncate">{text}</span>
            {caret && <span className="search-caret" />}
          </span>
        )}
      </div>
      <Button type="submit" className="min-h-11 rounded-full px-5 font-semibold">
        Check
      </Button>
    </form>
  );
}

const LIVE_MAX = 5;

/**
 * The rows a Simple live result may show: never a "possibly the same" (title-only) row, which only the full
 * search page shows with its label (spec 9a). The API groups trusted rows only; this keeps the rule if it ever does not.
 */
function exactItems(g: GroupResult) {
  return g.items.filter((i) => !i.possible);
}

/** The cheapest row with a price (rows come cheapest first), else the first row. */
function cheapest(items: GroupResult['items']) {
  return items.find((i) => i.priceCents !== null) ?? items[0]!;
}

/** What a result row says about its verdict, for the description of its link (empty when there is nothing to say). */
function verdictText(best: GroupResult['items'][number]): string {
  if (best.verdict === 'avoid') return best.bf ? alarmText(best) : avoidSummary(best);
  if (best.verdict === 'good') return 'Real deal';
  return best.bf ? 'Black Friday' : '';
}

/**
 * One live result: a single link over the whole row. Its name is "<title> at <shop>, <price>" (or
 * "<title>, from <price> at <N> shops") written in a screen reader only span, while the visible text is
 * aria-hidden so the words are not read twice; the visible words are all in the name. The verdict is the
 * link's description.
 */
function LiveRow({ group, replace }: { group: GroupResult; replace: boolean }) {
  const descId = useId();
  const items = exactItems(group);
  if (items.length === 0) return null;
  const best = cheapest(items);
  const shops = new Set(items.map((i) => i.shopSlug)).size;
  const price = best.priceCents === null ? NO_PRICE : formatEuro(best.priceCents);
  const name =
    shops > 1
      ? best.priceCents === null
        ? `${group.title}, ${NO_PRICE} at ${shops} shops`
        : `${group.title}, from ${price} at ${shops} shops`
      : `${group.title} at ${best.shop}, ${price}`;
  const verdict = verdictText(best);
  return (
    <li className="relative">
      <Link
        to={`/p/${best.id}`}
        replace={replace}
        aria-describedby={verdict ? descId : undefined}
        className="flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 outline-none hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring"
      >
        <span className="sr-only">{name}</span>
        <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{group.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {shops > 1 ? `${shops} shops` : best.shop}
              {best.verdict === 'avoid' && (
                <>
                  {' · '}
                  <span className="font-semibold text-bad">{verdict}</span>
                </>
              )}
              {best.verdict === 'good' && (
                <>
                  {' · '}
                  <span className="font-semibold text-good">{verdict}</span>
                </>
              )}
              {best.bf && best.verdict !== 'avoid' && <BlackFridayMark className="ml-1.5 py-0 align-middle text-[11px]" />}
            </span>
          </span>
          <span className="max-w-28 flex-none text-right text-sm font-bold tabular-nums">
            {best.priceCents === null ? <span className="text-xs font-medium text-muted-foreground">{NO_PRICE}</span> : price}
          </span>
        </span>
      </Link>
      {verdict && (
        <span id={descId} className="sr-only">
          {verdict}
        </span>
      )}
    </li>
  );
}

/**
 * Search with results under the box as you type (after the debounce); Enter opens the search page
 * with the query. With `shop` (a slug) the API and the search page are limited to that shop.
 */
export function LiveSearch({
  shop = null,
  placeholder,
  animated = false,
  className,
  value: controlled,
  onValueChange,
  replace = false,
}: {
  shop?: string | null;
  placeholder?: string;
  animated?: boolean;
  className?: string;
  /** keeps the typed text outside (the search overlay keeps it between openings); uncontrolled when left out */
  value?: string;
  onValueChange?: (value: string) => void;
  /** navigates by replacing the current history entry (the search overlay's own entry) instead of adding one */
  replace?: boolean;
}) {
  const [own, setOwn] = useState('');
  const value = controlled ?? own;
  const setValue = onValueChange ?? setOwn;
  const navigate = useNavigate();
  const { term, state } = useSearch(value, shop);
  const headingId = useId();

  return (
    <div className={cn('relative mx-auto w-full max-w-xl', className)}>
      <SearchBox value={value} onChange={setValue} onSubmit={(q) => q && navigate(searchPath(q, shop), { replace })} placeholder={placeholder} animated={animated} />
      <SearchStatus state={state} term={term} />
      {state.status !== 'idle' && (
        <section aria-labelledby={headingId} className="glass mt-2 p-2 text-left">
          <h2 id={headingId} className="sr-only">
            Search results
          </h2>
          {state.status === 'loading' && <p className="flex min-h-11 items-center px-3 text-sm text-muted-foreground">Searching</p>}
          {state.status === 'empty' && <p className="flex min-h-11 items-center px-3 text-sm">No products match "{term}".</p>}
          {state.status === 'error' && (
            <div className="flex min-h-11 flex-wrap items-center gap-3 px-3">
              <p className="text-sm">Search is not available right now.</p>
              <Button variant="outline" className="min-h-11" onClick={state.retry}>
                Try again
              </Button>
            </div>
          )}
          {state.status === 'ready' && (
            <>
              <ul className="m-0 list-none p-0">
                {state.data.results.slice(0, LIVE_MAX).map((g) => (
                  <LiveRow key={g.canonicalId === null ? `s${g.items[0]!.id}` : `c${g.canonicalId}`} group={g} replace={replace} />
                ))}
              </ul>
              <Link
                to={searchPath(term ?? '', shop)}
                replace={replace}
                className="flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold text-brand outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                See all results
              </Link>
            </>
          )}
        </section>
      )}
    </div>
  );
}
