import { TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { DEFAULT_SETTINGS } from '../../../src/site/settings.js';
import { alarmText, avoidFact, avoidSummary, BlackFridayMark, NO_PRICE } from '@/components/site/DealCard';
import { Notice } from '@/components/site/DealList';
import { useMode } from '@/components/site/ModeProvider';
import { SEARCH_DEBOUNCE_MS, SearchBox, searchPath, useSearch } from '@/components/site/SearchBox';
import { ShopBadge } from '@/components/site/ShopBadge';
import { Button } from '@/components/ui/button';
import { type GroupItem, type GroupResult, useDebounced } from '@/lib/api';
import { formatEuro } from '@/lib/format';

const SLUG = /^[a-z0-9-]{1,64}$/;

/**
 * For each exactly matched row with a price, the cheapest exactly matched row at another shop that
 * is at least `cheaperPct` cheaper. Rows that are only "possibly the same" (title-only match) are
 * left out on both sides: a title match never backs a cheaper claim.
 */
export function cheaperElsewhere(items: GroupItem[], cheaperPct: number): Map<number, GroupItem> {
  const exact = items.filter((i) => !i.possible && i.priceCents !== null);
  const out = new Map<number, GroupItem>();
  for (const item of exact) {
    let best: GroupItem | null = null;
    for (const o of exact) {
      if (o.shopSlug === item.shopSlug) continue;
      if (o.priceCents! * 100 > item.priceCents! * (100 - cheaperPct)) continue;
      if (!best || o.priceCents! < best.priceCents!) best = o;
    }
    if (best) out.set(item.id, best);
  }
  return out;
}

function ResultRow({ item, groupTitle, cheaper }: { item: GroupItem; groupTitle: string; cheaper: GroupItem | null }) {
  const { mode } = useMode();
  const avoid = item.verdict === 'avoid';
  const fact = avoid ? avoidFact(item) : null;
  return (
    <li className="flex items-start gap-3 border-t border-line py-3 first:border-t-0 first:pt-1 last:pb-0">
      <ShopBadge name={item.shop} size="sm" className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link
          to={`/p/${item.id}`}
          className="self-start rounded-sm font-semibold outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
              Cheaper elsewhere: {formatEuro(cheaper.priceCents!)} at {cheaper.shop}
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
  const cheaper = cheaperElsewhere(group.items, DEFAULT_SETTINGS.thresholds.cheaperPct);
  const shops = new Set(group.items.map((i) => i.shopSlug)).size;
  return (
    <article aria-labelledby={id} className="glass p-4">
      <h2 id={id} className="leading-snug font-semibold">
        {group.title}
      </h2>
      {shops > 1 && <p className="text-xs text-muted-foreground">{shops} shops, cheapest first</p>}
      <ul className="m-0 mt-2 list-none p-0">
        {group.items.map((item) => (
          <ResultRow key={item.id} item={item} groupTitle={group.title} cheaper={cheaper.get(item.id) ?? null} />
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
            <div role="status" aria-label="Searching" className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} aria-hidden="true" className="glass h-32 opacity-60" />
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
              <p role="status" className="text-sm text-muted-foreground">
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
