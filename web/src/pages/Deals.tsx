import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { SITE_CATEGORIES } from '../../../src/site/categories.js';
import { DealList, DealListSkeleton, Notice } from '@/components/site/DealList';
import { useMode } from '@/components/site/ModeProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ApiError, api, type Card, type DealsResponse, useApi, useDebounced } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Deals per page (the API's page size). */
const PAGE_SIZE = 24;
const MAX_EUROS = 100_000;
const PRICE_DEBOUNCE_MS = 400;
const EUROS = /^\d{1,6}$/;
const SLUG = /^[a-z0-9-]{1,64}$/;
const CATEGORY_SLUGS = new Set<string>(SITE_CATEGORIES.map((c) => c.slug));

const BAD_EUROS = 'Use whole euros from 0 to 100000.';
const BAD_RANGE = 'The lowest price is above the highest.';

const FIELD = 'min-h-11 w-full rounded-xl border border-line bg-glass px-3 text-base text-ink outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

type DealType = 'good' | 'avoid';

/** The filters of the page. They live in the URL (?type=&category=&shop=&min=&max=); anything the API would reject is dropped. */
export type Filters = { type: DealType; category: string | null; shop: string | null; min: number | null; max: number | null };

type Euros = { ok: true; value: number | null } | { ok: false };

/** Whole euros 0..100000; empty text is "no bound". */
function parseEuros(text: string | null): Euros {
  const t = (text ?? '').trim();
  if (t === '') return { ok: true, value: null };
  if (!EUROS.test(t)) return { ok: false };
  const n = Number(t);
  return n <= MAX_EUROS ? { ok: true, value: n } : { ok: false };
}

export function readFilters(p: URLSearchParams): Filters {
  const category = p.get('category');
  const shop = p.get('shop');
  const lo = parseEuros(p.get('min'));
  const hi = parseEuros(p.get('max'));
  let min = lo.ok ? lo.value : null;
  let max = hi.ok ? hi.value : null;
  if (min !== null && max !== null && min > max) min = max = null;
  return {
    type: p.get('type') === 'avoid' ? 'avoid' : 'good',
    category: category !== null && CATEGORY_SLUGS.has(category) ? category : null,
    shop: shop !== null && SLUG.test(shop) ? shop : null,
    min,
    max,
  };
}

const filterKey = (f: Filters) => JSON.stringify([f.type, f.category, f.shop, f.min, f.max]);
const plural = (n: number) => `${n} ${n === 1 ? 'deal' : 'deals'}`;

function Field({ label, htmlFor, children, className }: { label: string; htmlFor: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * Lowest and highest price in whole euros. The text is the user's own while typing; once it has settled
 * and is valid it is written to the URL (replacing the entry). A URL changed from outside (Back, a link,
 * Clear filters) replaces the text.
 */
function PriceRange({ min, max, onCommit }: { min: number | null; max: number | null; onCommit: (min: number | null, max: number | null) => void }) {
  const ids = [useId(), useId(), useId()] as const;
  const [minText, setMinText] = useState(min === null ? '' : String(min));
  const [maxText, setMaxText] = useState(max === null ? '' : String(max));
  const written = useRef({ min, max });
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  });

  useEffect(() => {
    if (min === written.current.min && max === written.current.max) return;
    written.current = { min, max };
    setMinText(min === null ? '' : String(min));
    setMaxText(max === null ? '' : String(max));
  }, [min, max]);

  const lo = parseEuros(minText);
  const hi = parseEuros(maxText);
  const problem = !lo.ok || !hi.ok ? BAD_EUROS : lo.value !== null && hi.value !== null && lo.value > hi.value ? BAD_RANGE : null;

  // both boxes settle together, so a half-typed pair is never written (the lowest while the highest is still being changed)
  const settled = useDebounced(`${minText}|${maxText}`, PRICE_DEBOUNCE_MS);
  useEffect(() => {
    const [settledMin, settledMax] = settled.split('|') as [string, string];
    const a = parseEuros(settledMin);
    const b = parseEuros(settledMax);
    if (!a.ok || !b.ok) return;
    if (a.value !== null && b.value !== null && a.value > b.value) return;
    if (a.value === written.current.min && b.value === written.current.max) return;
    written.current = { min: a.value, max: b.value };
    commit.current(a.value, b.value);
  }, [settled]);

  const input = (id: string, label: string, text: string, set: (v: string) => void) => (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={id === ids[0] ? '0' : 'Any'}
        value={text}
        aria-invalid={problem !== null || undefined}
        aria-describedby={problem ? ids[2] : undefined}
        onChange={(e) => set(e.target.value)}
        className={cn(FIELD, 'h-auto md:text-base')}
      />
    </Field>
  );

  return (
    <div className="flex flex-col gap-1 sm:col-span-2">
      <div className="grid grid-cols-2 gap-3">
        {input(ids[0], 'Lowest price (EUR)', minText, setMinText)}
        {input(ids[1], 'Highest price (EUR)', maxText, setMaxText)}
      </div>
      {problem && (
        <p id={ids[2]} className="text-sm font-medium text-bad">
          {problem}
        </p>
      )}
    </div>
  );
}

type Loaded = { fk: string; pages: Card[][]; total: number; minHistoryDays: number };

/**
 * The deals for the filters, page by page. Page 1 comes first; "Load more" asks for the next page and
 * appends it. A change of filters starts again at page 1 (the page number is state, not in the URL) and
 * useApi aborts the request in flight, so only an answer for the current filters and page is added.
 */
function useDealPages(filters: Filters) {
  const fk = filterKey(filters);
  const [paging, setPaging] = useState({ fk, page: 1 });
  // Any change of filters (a click, Back, a link) starts again at page 1 for the new key: the page
  // last loaded for an earlier key must not come back with it.
  if (paging.fk !== fk) setPaging({ fk, page: 1 });
  const page = paging.fk === fk ? paging.page : 1;
  const res = useApi<DealsResponse>(
    JSON.stringify([fk, page]),
    (signal) => api.deals({ ...filters, page: page > 1 ? page : undefined }, signal),
    (d) => {
      if (!Array.isArray(d?.items) || typeof d.total !== 'number') throw new ApiError(200); // a 200 without the expected shape
      return d.items.length === 0;
    },
  );
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const data = res.status === 'ready' || res.status === 'empty' ? res.data : null;
  useEffect(() => {
    if (!data) return;
    setLoaded((prev) => {
      const before = prev && prev.fk === fk ? prev.pages.slice(0, page - 1) : [];
      return { fk, pages: [...before, data.items], total: data.total, minHistoryDays: data.minHistoryDays };
    });
  }, [data, fk, page]);

  const current = loaded && loaded.fk === fk ? loaded : null;
  const items = useMemo(() => {
    const seen = new Set<number>();
    return (current?.pages ?? []).flat().filter((c) => !seen.has(c.id) && seen.add(c.id));
  }, [current]);
  const lastPage = current?.pages.at(-1);
  const hasMore = current !== null && current.pages.length * PAGE_SIZE < current.total && (lastPage?.length ?? 0) > 0;
  const loadMore = useCallback(() => {
    if (current) setPaging({ fk, page: current.pages.length + 1 });
  }, [current, fk]);

  return {
    fk,
    current,
    items,
    hasMore,
    loadMore,
    firstLoad: current === null && res.status !== 'error',
    firstError: current === null && res.status === 'error',
    loadingMore: current !== null && page > 1 && res.status === 'loading',
    moreFailed: current !== null && page > 1 && res.status === 'error',
    retry: res.retry,
  };
}

const TOGGLE =
  'min-h-11 flex-1 gap-2 rounded-xl px-3 font-bold text-muted-foreground hover:bg-secondary hover:text-ink data-[state=on]:bg-ink data-[state=on]:text-background data-[state=on]:hover:bg-ink data-[state=on]:hover:text-background';

/** Black Friday deals: the Good / Avoid switch, filters kept in the URL, and a list that grows with Load more. */
export function DealsPage() {
  const { mode } = useMode();
  const advanced = mode === 'advanced';
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const { type, category, shop, min, max } = filters;
  const categoryId = useId();
  const shopId = useId();
  const headingId = useId();
  const noteId = useId();

  /** Changing a filter writes it to the URL (a new history entry, or a replaced one for the typed price). */
  const change = useCallback(
    (patch: Partial<Filters>, replace = false) => {
      setParams(
        (prev) => {
          const f = { ...readFilters(prev), ...patch };
          const next = new URLSearchParams(prev);
          next.set('type', f.type);
          for (const [key, value] of [['category', f.category], ['shop', f.shop], ['min', f.min], ['max', f.max]] as const) {
            if (value === null) next.delete(key);
            else next.set(key, String(value));
          }
          return next;
        },
        { replace },
      );
    },
    [setParams],
  );

  const categories = useApi(
    'categories',
    (signal) => api.categories(signal),
    (d) => {
      if (!Array.isArray(d?.categories)) throw new ApiError(200);
      return false;
    },
  );
  const shops = useApi(
    advanced ? 'shops' : null,
    (signal) => api.shops(signal),
    (d) => {
      if (!Array.isArray(d?.shops)) throw new ApiError(200);
      return false;
    },
  );
  const categoryList = categories.status === 'ready' ? categories.data.categories : null;
  // switch totals: every category plus the rows without one, so no deal is silently left out
  const none = categories.status === 'ready' ? categories.data.uncategorised : null;
  const counts = categoryList && {
    good: categoryList.reduce((n, c) => n + c.good, none?.good ?? 0),
    avoid: categoryList.reduce((n, c) => n + c.avoid, none?.avoid ?? 0),
  };
  // the counts are global (all shops, all prices), so they are labelled as such
  const showCounts = advanced && counts !== null;
  const shopList = shops.status === 'ready' ? shops.data.shops : [];

  const pages = useDealPages(filters);
  const { current, items } = pages;
  const hasFilters = category !== null || shop !== null || min !== null || max !== null;

  // "Load more" moves focus to the first card it added (the list starts there), not back to the button
  const listRef = useRef<HTMLDivElement>(null);
  const focusFrom = useRef<{ fk: string; index: number } | null>(null);
  useEffect(() => {
    const want = focusFrom.current;
    if (!want || want.fk !== pages.fk || items.length <= want.index) return;
    focusFrom.current = null;
    listRef.current?.querySelectorAll('li')[want.index]?.querySelector<HTMLElement>('h3 a')?.focus();
  }, [items.length, pages.fk]);
  useEffect(() => {
    focusFrom.current = null; // a pending request belongs to the filters it was made for
  }, [pages.fk]);
  const moreRef = useRef<HTMLButtonElement>(null);

  const onMore = () => {
    if (pages.loadingMore) return;
    if (pages.moreFailed) return pages.retry();
    focusFrom.current = { fk: pages.fk, index: items.length };
    pages.loadMore();
  };

  let statusText = 'Loading deals';
  if (current) {
    if (pages.loadingMore) statusText = 'Loading more deals';
    else if (pages.moreFailed) statusText = 'More deals could not be loaded';
    else statusText = items.length > 0 && items.length < current.total ? `${plural(current.total)}, ${items.length} shown` : plural(current.total);
  } else if (pages.firstError) statusText = 'Deals could not be loaded';

  const label = type === 'good' ? 'Good deals' : 'Deals to avoid';
  const clearFilters = () => change({ category: null, shop: null, min: null, max: null });
  const hidden = [shop !== null && 'shop', (min !== null || max !== null) && 'price'].filter(Boolean) as string[];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight">Black Friday deals</h1>

      <ToggleGroup
        type="single"
        aria-label="Deal type"
        aria-describedby={showCounts ? noteId : undefined}
        value={type}
        onValueChange={(v) => {
          if (v === 'good' || v === 'avoid') change({ type: v });
        }}
        className="glass w-full gap-1 rounded-2xl p-1 sm:w-fit sm:min-w-80"
      >
        <ToggleGroupItem value="good" className={TOGGLE}>
          <span aria-hidden="true" className="size-2.5 rounded-full bg-good" />
          <span>
            Good deals
            {advanced && counts && (
              <>
                {' '}
                <span className="ml-0.5 font-semibold tabular-nums">{counts.good}</span>
              </>
            )}
          </span>
        </ToggleGroupItem>
        <ToggleGroupItem value="avoid" className={TOGGLE}>
          <span aria-hidden="true" className="size-2.5 rounded-full bg-bad" />
          <span>
            Deals to avoid
            {advanced && counts && (
              <>
                {' '}
                <span className="ml-0.5 font-semibold tabular-nums">{counts.avoid}</span>
              </>
            )}
          </span>
        </ToggleGroupItem>
      </ToggleGroup>

      {showCounts && (
        <p id={noteId} className="-mt-2 text-xs text-muted-foreground">
          Counts cover all shops and prices.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Category" htmlFor={categoryId}>
          <select id={categoryId} aria-describedby={showCounts ? noteId : undefined} className={FIELD} value={category ?? ''} onChange={(e) => change({ category: e.target.value || null })}>
            <option value="">All categories</option>
            {(categoryList ?? SITE_CATEGORIES.map((c) => ({ ...c, count: 0, good: 0, avoid: 0 }))).map((c) => (
              <option key={c.slug} value={c.slug}>
                {advanced && categoryList ? `${c.name} (${c[type]})` : c.name}
              </option>
            ))}
          </select>
        </Field>
        {advanced && (
          <>
            <Field label="Shop" htmlFor={shopId}>
              <select id={shopId} className={FIELD} value={shop ?? ''} onChange={(e) => change({ shop: e.target.value || null })}>
                <option value="">All shops</option>
                {shop !== null && !shopList.some((s) => s.slug === shop) && <option value={shop}>{shop}</option>}
                {shopList.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <PriceRange min={min} max={max} onCommit={(lo, hi) => change({ min: lo, max: hi }, true)} />
          </>
        )}
      </div>

      {!advanced && hidden.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
          <span>Some filters from the link are on: {hidden.join(', ')}.</span>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => change({ shop: null, min: null, max: null })}
          >
            Clear {hidden.join(' and ')}
          </Button>
        </p>
      )}

      {/* one live region, always there: it announces loading, the count and errors */}
      <p role="status" data-testid="deals-status" className="sr-only">
        {statusText}
      </p>
      {advanced && current && !pages.loadingMore && (
        <p data-testid="deals-count" aria-hidden="true" className="text-sm text-muted-foreground">
          {statusText}
        </p>
      )}

      <section aria-labelledby={headingId} className="flex flex-col gap-4">
        <h2 id={headingId} className="sr-only">
          {label}
        </h2>
        {pages.firstLoad && <DealListSkeleton count={6} />}
        {pages.firstError && (
          <Notice
            title="Deals could not be loaded."
            action={
              <Button variant="outline" className="min-h-11" onClick={pages.retry}>
                Try again
              </Button>
            }
          >
            Check your connection and try again.
          </Notice>
        )}
        {current && items.length === 0 &&
          (hasFilters ? (
            <Notice
              title="No deals match these filters."
              action={
                <Button variant="outline" className="min-h-11" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            >
              Try a different category, shop or price.
            </Notice>
          ) : (
            <Notice title={`No ${label.toLowerCase()} judged yet.`}>
              We need {current.minHistoryDays} days of prices before we judge a deal. Until then, search a product to see its price.
            </Notice>
          ))}
        {items.length > 0 && (
          <div ref={listRef}>
            <DealList cards={items} />
          </div>
        )}
        {pages.hasMore && (
          <div className="flex flex-col items-center gap-2">
            {pages.moreFailed && (
              <p className="text-sm font-medium text-bad">More deals could not be loaded.</p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                ref={moreRef}
                variant="outline"
                className="min-h-11 px-6 aria-disabled:pointer-events-none aria-disabled:opacity-60"
                aria-disabled={pages.loadingMore || undefined}
                aria-busy={pages.loadingMore || undefined}
                onClick={onMore}
              >
                Load more
              </Button>
              {pages.moreFailed && (
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    moreRef.current?.focus();
                    pages.retry();
                  }}
                >
                  Try again
                </Button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
