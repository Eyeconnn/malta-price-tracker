// Typed client for the admin API (web/worker/admin.ts). The browser sends the admin Basic auth credentials it
// already holds for this site; writes go as JSON from this origin, as the Worker requires.
import type { SiteSettings } from '../../../src/site/settings.js';
import type { ShopRequestStatus } from '../../../src/shop-requests/statuses.js';
import type { AdminReport, AdminShop, MatchGroup, ReportStatus, UnmappedCategory } from '../../worker/admin.js';
import type { AdminShopRequest } from '../../worker/shop-requests.js';
import { ApiError } from './api';

export type { AdminReport, AdminShop, AdminShopRequest, MatchGroup, ReportStatus, ShopRequestStatus, UnmappedCategory };

/** POST /api/admin/shop-requests: the stored request, or what the Worker refused (field, reason, slug, current status). */
export type CreateShopRequestResult =
  | { ok: true; request: AdminShopRequest }
  | { ok: false; status: number; field?: string; reason?: string; slug?: string; current?: ShopRequestStatus };

async function createShopRequest(body: { url: string; name: string | null; category: string | null }): Promise<CreateShopRequestResult> {
  const res = await fetch('/api/admin/shop-requests', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  if (res.status === 201 && data.request) return { ok: true, request: data.request as AdminShopRequest };
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return { ok: false, status: res.status, field: s(data.field), reason: s(data.reason), slug: s(data.slug), current: s(data.status) as ShopRequestStatus | undefined };
}
export type Paged = { total: number; page: number; pageSize: number };

/** A JSON request; non-2xx answers throw ApiError with `field` set from a 400's { field } or { error }. */
async function call<T>(method: 'GET' | 'PUT' | 'PATCH', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    signal,
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let field: string | undefined;
    try {
      const err = (await res.json()) as { error?: string; field?: string };
      field = err.field ?? err.error;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, field);
  }
  try {
    return (await res.json()) as T;
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(res.status);
  }
}

const q = (params: Record<string, string | number>) => `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

export const adminApi = {
  settings: (signal?: AbortSignal) => call<{ settings: SiteSettings }>('GET', '/api/admin/settings', undefined, signal),
  saveSettings: (settings: SiteSettings) => call<{ settings: SiteSettings }>('PUT', '/api/admin/settings', settings),
  categories: (signal?: AbortSignal) => call<{ unmapped: UnmappedCategory[] }>('GET', '/api/admin/categories', undefined, signal),
  reports: (status: ReportStatus, page: number, signal?: AbortSignal) =>
    call<{ items: AdminReport[] } & Paged>('GET', `/api/admin/reports${q({ status, page })}`, undefined, signal),
  updateReport: (id: number, status: ReportStatus, adminNote?: string | null) =>
    call<{ report: AdminReport }>('PATCH', `/api/admin/reports/${id}`, adminNote === undefined ? { status } : { status, adminNote }),
  shops: (signal?: AbortSignal) => call<{ shops: AdminShop[] }>('GET', '/api/admin/shops', undefined, signal),
  setShopHidden: (slug: string, hidden: boolean) => call<{ shop: { slug: string; hidden: boolean } }>('PATCH', `/api/admin/shops/${encodeURIComponent(slug)}`, { hidden }),
  matches: (pendingOnly: boolean, page: number, signal?: AbortSignal) =>
    call<{ groups: MatchGroup[] } & Paged>('GET', `/api/admin/matches${q({ pending: pendingOnly ? 1 : 0, page })}`, undefined, signal),
  confirmMatch: (id: number, confirmed: boolean) => call<{ member: { id: number; confirmed: boolean } }>('PATCH', `/api/admin/matches/${id}`, { confirmed }),
  shopRequests: (signal?: AbortSignal) => call<{ requests: AdminShopRequest[]; maxQueued: number }>('GET', '/api/admin/shop-requests', undefined, signal),
  createShopRequest,
  /** 'pending' retries a failed or blocked request; 'rejected' drops it */
  setShopRequestStatus: (id: number, status: 'pending' | 'rejected') => call<{ request: AdminShopRequest }>('PATCH', `/api/admin/shop-requests/${id}`, { status }),
};

/** A short sentence for a failed admin request. */
export function adminErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 400) return e.field ? `Not saved: check ${e.field}.` : 'Not saved: check the values.';
    if (e.status === 401) return 'Your admin login has expired. Reload the page to sign in again.';
    if (e.status === 404) return 'Not found. It may have been removed; reload the page.';
    if (e.status === 409) return 'It changed in the meantime. Reload the page to see its current state.';
    if (e.status === 429) return '20 shops are already waiting to be checked. Try again after the next check.';
  }
  return 'Something went wrong. Try again.';
}
