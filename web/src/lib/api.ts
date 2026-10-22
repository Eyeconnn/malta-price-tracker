// The one typed client for the public API (web/worker/api.ts, reports.ts), and useApi for components.
// Response types are built from the Worker's own types, so a change there breaks the build here.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PhraseSlot, Thresholds } from '../../../src/site/settings.js';
import type { VerdictFacts } from '../../../src/site/verdict.js';
import type {
  Card,
  CategoryCount,
  Change,
  CheaperTarget,
  GroupItem,
  GroupResult,
  HistoryObs,
  Label,
  OtherShop,
  ProductInfo,
  ShopInfo,
  ShopRating,
  ShopStats,
  ShopSummary,
  Variant,
} from '../../worker/data.js';
import type { ReportBody, ReportReason, ReportTarget } from '../../worker/reports.js';

export type {
  Card,
  Change,
  CheaperTarget,
  GroupItem,
  GroupResult,
  HistoryObs,
  Label,
  OtherShop,
  ProductInfo,
  ShopInfo,
  ShopRating,
  ShopStats,
  ShopSummary,
  Variant,
};
export type { ReportBody, ReportReason, ReportTarget };

/** minHistoryDays: days of prices needed before a deal is judged (stored threshold) */
export type HomeResponse = { phrases: Record<PhraseSlot, string[]>; good: Card[]; avoid: Card[]; minHistoryDays: number };
export type SearchResponse = { results: GroupResult[] };
export type DealsResponse = { items: Card[]; total: number; minHistoryDays: number };
export type ShopsResponse = { shops: ShopSummary[] };
export type ShopResponse = {
  shop: ShopInfo;
  rating: ShopRating;
  avoid: Card[];
  good: Card[];
  rises: Change[];
  drops: Change[];
  stats: ShopStats;
  /** days the rises and drops look back (the stored raise window) */
  raiseWindowDays: number;
};
export type ProductResponse = {
  product: Omit<ProductInfo, 'verdict' | 'reason' | 'facts'>;
  variants: Variant[];
  history: HistoryObs[];
  verdict: { label: Label; reason: string | null; facts: VerdictFacts | null };
  others: OtherShop[];
  /** the cheapest exact match at another shop, at least cheaperPct cheaper; null when none */
  cheaper: OtherShop | null;
  /** days of prices needed before a deal is judged (stored threshold) */
  minHistoryDays: number;
  /** days back a price change counts as recent (stored threshold, as the verdict's raise window) */
  raiseWindowDays: number;
};
/** The stored verdict and rating thresholds (stored settings merged over the defaults) */
export type ThresholdsResponse = { thresholds: Thresholds };
export type CategoriesResponse = {
  categories: (CategoryCount & { name: string })[];
  /** rows without a category (not in `categories`) */
  uncategorised: { count: number; good: number; avoid: number };
};

/** min/max: price range in whole euros (inclusive); page: 1-based, 24 deals per page */
export type DealsQuery = { type: 'good' | 'avoid'; category?: string | null; shop?: string | null; min?: number | null; max?: number | null; page?: number };

/** A non-2xx answer from the API (or a body that is not JSON). */
export class ApiError extends Error {
  /**
   * field: the `error` of a 400 answer to a write (the field that was rejected);
   * retryAfter: seconds from a 429's retry-after header, null when absent or not a number
   */
  constructor(
    readonly status: number,
    readonly field?: string,
    readonly retryAfter: number | null = null,
  ) {
    super(`API answered ${status}`);
    this.name = 'ApiError';
  }
}

function query(params: Record<string, string | number | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new ApiError(res.status);
  try {
    return (await res.json()) as T;
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(res.status);
  }
}

/** POST /api/reports; resolves on 201, otherwise throws ApiError (429: rate limited with retryAfter, 400: a bad field). */
async function postReport(body: ReportBody): Promise<void> {
  const res = await fetch('/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) {
    let field: string | undefined;
    try {
      field = ((await res.json()) as { error?: string }).error;
    } catch {
      // not JSON
    }
    const retry = res.headers.get('retry-after');
    throw new ApiError(res.status, field, retry !== null && /^\d{1,9}$/.test(retry.trim()) ? Number(retry) : null);
  }
}

export const api = {
  home: (signal?: AbortSignal) => get<HomeResponse>('/api/home', signal),
  /** results are empty for a query under 2 characters (the server checks too) */
  search: (q: string, shop: string | null, signal?: AbortSignal) => get<SearchResponse>(`/api/search${query({ q, shop })}`, signal),
  deals: (q: DealsQuery, signal?: AbortSignal) =>
    get<DealsResponse>(`/api/deals${query({ type: q.type, category: q.category, shop: q.shop, min: q.min, max: q.max, page: q.page })}`, signal),
  shops: (signal?: AbortSignal) => get<ShopsResponse>('/api/shops', signal),
  shop: (slug: string, signal?: AbortSignal) => get<ShopResponse>(`/api/shops/${encodeURIComponent(slug)}`, signal),
  product: (id: number, signal?: AbortSignal) => get<ProductResponse>(`/api/products/${encodeURIComponent(String(id))}`, signal),
  categories: (signal?: AbortSignal) => get<CategoriesResponse>('/api/categories', signal),
  thresholds: (signal?: AbortSignal) => get<ThresholdsResponse>('/api/thresholds', signal),
  report: postReport,
};

export type ApiState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'empty'; data: T }
  | { status: 'ready'; data: T };

/**
 * Loads `load` whenever `key` changes (null: nothing to load, status 'idle'). The previous request
 * is aborted (also on unmount) and its answer ignored, so only the response for the current key is
 * ever shown. `isEmpty` turns a successful but empty answer into status 'empty'; it may also check
 * the shape, and anything it throws becomes status 'error'. `retry` loads the same key again.
 */
export function useApi<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  isEmpty?: (data: T) => boolean,
): ApiState<T> & { retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; attempt: number; state: ApiState<T> } | null>(null);
  const loadRef = useRef(load);
  const isEmptyRef = useRef(isEmpty);
  useEffect(() => {
    loadRef.current = load;
    isEmptyRef.current = isEmpty;
  });

  useEffect(() => {
    if (key === null) return;
    const ctrl = new AbortController();
    loadRef.current(ctrl.signal)
      .then((data): ApiState<T> => (isEmptyRef.current?.(data) ? { status: 'empty', data } : { status: 'ready', data }))
      .then(
        (state) => {
          if (!ctrl.signal.aborted) setResult({ key, attempt, state });
        },
        (error: unknown) => {
          if (!ctrl.signal.aborted) setResult({ key, attempt, state: { status: 'error', error } });
        },
      );
    return () => ctrl.abort();
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  // A result for another key or attempt is stale: until the new one arrives the state is loading.
  const state: ApiState<T> =
    key === null ? { status: 'idle' } : result && result.key === key && result.attempt === attempt ? result.state : { status: 'loading' };
  return { ...state, retry };
}

/** `value`, but only after it has stayed the same for `ms` milliseconds. The first value is immediate. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
