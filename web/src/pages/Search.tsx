import { TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { alarmText, avoidFact, avoidSummary, BlackFridayMark, NO_PRICE } from '@/components/site/DealCard';
import { Notice } from '@/components/site/DealList';
import { useMode } from '@/components/site/ModeProvider';
import { SEARCH_DEBOUNCE_MS, SearchBox, SearchStatus, searchPath, useSearch } from '@/components/site/SearchBox';
import { ShopBadge } from '@/components/site/ShopBadge';
import { Button } from '@/components/ui/button';
import { type GroupItem, type GroupResult, useDebounced } from '@/lib/api';
import { formatEuro } from '@/lib/format';
import { cn } from '@/lib/utils';

const SLUG = /^[a-z0-9-]{1,64}$/;

/**
 * One shop's row of a product group. `item.cheaper` is decided by the API (Ruling R36); it is only shown here.
 * The shop link is stretched over the whole result (its ::after fills the nearest positioned box), so a
 * tap anywhere opens the product. With `stretch` = 'row' that box is this row (several shops in the group);
 * with 'card' it is the group card around it (one row), which also covers the heading.
 */
function ResultRow({ item, groupTitle, stretch }: { item: GroupItem; groupTitle: string; stretch: 'row' | 'card' }) {
  const { mode } = useMode();
  const { cheaper } = item;
  const avoid = item.verdict === 'avoid';
  const fact = avoid ? avoidFact(item) : null;
  return (
    <li
      className={cn(
        'flex min-h-11 items-start gap-3 border-t border-line py-3 first:border-t-0 first:pt-1 last:pb-0',
        stretch === 'row' &&
          'relative -mx-2 rounded-xl px-2 transition-colors hover:bg-secondary has-[a:focus-visible]:ring-[3px] has-[a:focus-visible]:ring-ring/50',
      )}
    >
      <ShopBadge name={item.shop} size="sm" className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link
          to={`/p/${item.id}`}
          aria-label={`${item.title} at ${item.shop}, ${item.priceCents === null ? NO_PRICE : formatEuro(item.priceCents)}`}
          className="self-start rounded-sm font-semibold outline-none after:absolute after:inset-0 after:content-[''] hover:underline"
        >
          {item.shop}
        </Link>
        {item.title !== groupTitle && <p className="truncate text-xs text-muted-foreground">{item.title}</p>}
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {avoid && item.bf ? (
            <span className="inline-flex items-center gap-1 rounded-lg bg-bad px-2 py-0.5 font-bold text-bad-ink">
              <TriangleAlert aria-hidden="true" className="size-3.5" />
              {alarmText(item)}
            </span>
          ) : (
            <>
              {item.bf && <BlackFridayMark />}
              {avoid && <span className="font-bold text-bad">{avoidSummary(item)}</span>}
            </>
          )}
          {item.verdict === 'good' && <span className="font-bold text-good">Real deal</span>}
          {item.possible && <span className="text-muted-foreground">Possibly the same product</span>}
          {cheaper && (
            <span className="rounded-lg border border-line bg-secondary px-2 py-0.5 font-semibold">
              Cheaper elsewhere: {formatEuro(cheaper.priceCents)} at {cheaper.shop}
            </span>
          )}
        </div>
        {fact && <p className="text-sm font-semibold text-bad">{fact}</p>}
        {mode === 'advanced' && item.reason && <p className="text-sm text-muted-foreground">{item.reason}</p>}
      </div>
      <p className="max-w-32 flex-none text-right font-bold tabular-nums">
        {item.priceCents === null ? <span className="text-xs font-medium text-muted-foreground">{NO_PRICE}</span> : formatEuro(item.priceCents)}
      </p>
    </li>
  );
}

function GroupCard({ group }: { group: GroupResult }) {
  const id = useId();
  const shops = new Set(group.items.map((i) => i.shopSlug)).size;
  const single = group.items.length === 1;
  return (
    <article
      aria-labelledby={id}
      className={cn(
        'glass min-h-11 p-4',
        single && 'relative transition-shadow hover:ring-2 hover:ring-ring/30 has-[a:focus-visible]:ring-[3px] has-[a:focus-visible]:ring-ring/50',
      )}
    >
      <h2 id={id} className="leading-snug font-semibold">
        {group.title}
      </h2>
      {shops > 1 && <p className="text-xs text-muted-foreground">{shops} shops, cheapest first</p>}
      <ul className="m-0 mt-2 list-none p-0">
        {group.items.map((item) => (
          <ResultRow key={item.id} item={item} groupTitle={group.title} stretch={single ? 'card' : 'row'} />
        ))}
      </ul>
    </article>
  );
}

/** Search: the query lives in ?q= (and an optional ?shop=); results are grouped by product across shops. */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  const shopParam = params.get('shop');
  const shop = shopParam !== null && SLUG.test(shopParam) ? shopParam : null;
  const [value, setValue] = useState(urlQuery);
  const { term, state } = useSearch(value, shop);

  // Typing writes ?q= once it settles (replacing the entry, so Back leaves the page); a URL changed
  // from outside (Back, a link) replaces the text.
  const written = useRef(urlQuery);
  useEffect(() => {
    if (urlQuery !== written.current) {
      written.current = urlQuery;
      setValue(urlQuery);
    }
  }, [urlQuery]);
  const settled = useDebounced(value.trim(), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    if (settled === written.current) return;
    written.current = settled;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (settled) next.set('q', settled);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [settled, setParams]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight">Search</h1>
      <SearchBox
        animated
        value={value}
        onChange={setValue}
        onSubmit={(q) => {
          written.current = q;
          setParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              if (q) next.set('q', q);
              else next.delete('q');
              return next;
            },
            { replace: true },
          );
        }}
      />
      <SearchStatus state={state} term={term} />
      {shop && (
        <p className="text-sm text-muted-foreground">
          Results from one shop only.{' '}
          <Link to={searchPath(value)} className="font-medium text-brand underline-offset-2 hover:underline">
            Search all shops
          </Link>
        </p>
      )}
      {state.status !== 'idle' && (
        <section aria-label="Search results" className="flex flex-col gap-3">
          {state.status === 'loading' && (
            <div aria-hidden="true" className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="glass h-32 opacity-60" />
              ))}
            </div>
          )}
          {state.status === 'empty' && <Notice title={`No products match "${term}".`}>Try fewer words, or the brand and model.</Notice>}
          {state.status === 'error' && (
            <Notice
              title="Search is not available right now."
              action={
                <Button variant="outline" className="min-h-11" onClick={state.retry}>
                  Try again
                </Button>
              }
            />
          )}
          {state.status === 'ready' && (
            <>
              <p className="text-sm text-muted-foreground">
                {state.data.results.length === 1 ? '1 product' : `${state.data.results.length} products`}
              </p>
              {state.data.results.map((g) => (
                <GroupCard key={g.canonicalId === null ? `s${g.items[0]!.id}` : `c${g.canonicalId}`} group={g} />
              ))}
            </>
          )}
        </section>
      )}
    </div>
  );
}
