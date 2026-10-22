import { Search } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { alarmText, avoidSummary, BlackFridayMark, NO_PRICE } from '@/components/site/DealCard';
import { Button } from '@/components/ui/button';
import { ApiError, type ApiState, api, type GroupResult, type SearchResponse, useApi, useDebounced } from '@/lib/api';
import { formatEuro } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Same limits as the server (web/worker/api.ts searchPattern). */
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 120;
export const SEARCH_DEBOUNCE_MS = 250;

const length = (s: string) => Array.from(s).length;

/** The path of the search page for a query. */
export function searchPath(q: string): string {
  const query = q.trim();
  return query ? `/search?${new URLSearchParams({ q: query })}` : '/search';
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
  className?: string;
};

/** The big search field with its Check button. */
export function SearchBox({ value, onChange, onSubmit, className }: SearchBoxProps) {
  const id = useId();
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
        Search a product
      </label>
      <Search aria-hidden="true" className="size-5 flex-none text-muted-foreground" />
      <input
        id={id}
        type="search"
        value={value}
        maxLength={SEARCH_MAX}
        autoComplete="off"
        enterKeyHint="search"
        placeholder="Search a product"
        onChange={(e) => onChange(e.target.value)}
        className="min-h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      <Button type="submit" className="min-h-11 rounded-full px-5 font-semibold">
        Check
      </Button>
    </form>
  );
}

const LIVE_MAX = 5;

/** The cheapest row of a group with a price (rows come cheapest first), else the first row. */
function cheapest(g: GroupResult) {
  return g.items.find((i) => i.priceCents !== null) ?? g.items[0]!;
}

function LiveRow({ group }: { group: GroupResult }) {
  const best = cheapest(group);
  const shops = new Set(group.items.map((i) => i.shopSlug)).size;
  return (
    <li>
      <Link
        to={`/p/${best.id}`}
        className="flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 outline-none hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{group.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {shops > 1 ? `${shops} shops` : best.shop}
            {best.verdict === 'avoid' && (
              <>
                {' · '}
                <span className="font-semibold text-bad">{best.bf ? alarmText(best) : avoidSummary(best)}</span>
              </>
            )}
            {best.verdict === 'good' && (
              <>
                {' · '}
                <span className="font-semibold text-good">Real deal</span>
              </>
            )}
            {best.bf && best.verdict !== 'avoid' && <BlackFridayMark className="ml-1.5 py-0 align-middle text-[11px]" />}
          </span>
        </span>
        <span className="max-w-28 flex-none text-right text-sm font-bold tabular-nums">
          {best.priceCents === null ? <span className="text-xs font-medium text-muted-foreground">{NO_PRICE}</span> : formatEuro(best.priceCents)}
        </span>
      </Link>
    </li>
  );
}

/**
 * Home's search: results appear under the box as you type (after the debounce); Enter opens the
 * search page with the query.
 */
export function LiveSearch({ className }: { className?: string }) {
  const [value, setValue] = useState('');
  const navigate = useNavigate();
  const { term, state } = useSearch(value);
  const headingId = useId();

  return (
    <div className={cn('relative mx-auto w-full max-w-xl', className)}>
      <SearchBox value={value} onChange={setValue} onSubmit={(q) => q && navigate(searchPath(q))} />
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
                  <LiveRow key={g.canonicalId === null ? `s${g.items[0]!.id}` : `c${g.canonicalId}`} group={g} />
                ))}
              </ul>
              <Link
                to={searchPath(term ?? '')}
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
