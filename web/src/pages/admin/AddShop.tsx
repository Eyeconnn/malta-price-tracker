// Admin "Add shop": the owner types a shop's web address; the PC task (pnpm shop-requests, every 15 minutes)
// checks robots.txt, detects the platform, runs a test scrape of 50 products and activates the shop when it
// passes. This page lists every request with its result and refreshes every 30 s while one is waiting or
// being checked. Everything the check stored came from the shop's own pages, so it is shown as plain text only
// (no links, no markup).
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ADDRESS_PROBLEM_TEXT, type AddressProblem, NAME_MAX, SHOP_CATEGORIES, parseShopAddress } from '../../../../src/shop-requests/address.js';
import { PLATFORM_LABELS, REJECT_FROM, RETRY_FROM, STATUS_LABELS } from '../../../../src/shop-requests/statuses.js';
import { Notice } from '@/components/site/DealList';
import { Button } from '@/components/ui/button';
import { type AdminShopRequest, type ShopRequestStatus, adminApi, adminErrorText } from '@/lib/admin-api';
import { formatEuro } from '@/lib/format';
import { cn } from '@/lib/utils';
import { type SaveState, SaveMessage, Section, fieldClass, useSaver } from './shared';

/** How often the list reloads while a request is waiting or being checked. */
export const REFRESH_MS = 30_000;

const when = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Malta' });
const categoryLabel = (c: string) => c.charAt(0).toUpperCase() + c.slice(1);
const hostOf = (origin: string) => origin.replace(/^https?:\/\//, '');

const CHIP: Record<ShopRequestStatus, string> = {
  pending: 'border-line text-foreground',
  checking: 'border-brand text-brand',
  active: 'border-good text-good',
  needs_setup: 'border-line text-foreground',
  blocked: 'border-bad text-bad',
  failed: 'border-bad text-bad',
  rejected: 'border-line text-muted-foreground',
};

function StatusChip({ status }: { status: ShopRequestStatus }) {
  return <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold', CHIP[status])}>{STATUS_LABELS[status]}</span>;
}

const NEXT_STEP: Partial<Record<ShopRequestStatus, string>> = {
  pending: 'Waiting for the next check (the PC looks every 15 minutes).',
  checking: 'Being checked now: robots.txt, the platform, then a test scrape of 50 products.',
  active: 'Joins the nightly scrape. It shows on the site after the next site-build.',
};

function robotsText(r: AdminShopRequest['robots']): string {
  if (!r) return 'Not checked yet';
  if (r.blockedBy) return `Blocked by ${r.blockedBy.rule}`;
  if (r.status === 'none') return 'No robots.txt (allowed)';
  return r.crawlDelaySeconds > 0 ? `Allowed, crawl delay ${r.crawlDelaySeconds} s` : 'Allowed, no crawl delay';
}

// ---------------------------------------------------------------- form

type FieldErrors = { url: string | null; name: string | null };

function refusalText(r: Extract<Awaited<ReturnType<typeof adminApi.createShopRequest>>, { ok: false }>): { field: 'url' | 'name' | 'category' | null; text: string } {
  if (r.status === 400 && r.field === 'url') return { field: 'url', text: ADDRESS_PROBLEM_TEXT[(r.reason as AddressProblem) ?? 'malformed'] ?? ADDRESS_PROBLEM_TEXT.malformed };
  if (r.status === 400 && r.field === 'name') return { field: 'name', text: `Use at most ${NAME_MAX} characters.` };
  if (r.status === 400 && r.field === 'category') return { field: 'category', text: 'Choose a category from the list.' };
  if (r.status === 409 && r.reason === 'shop') {
    const slug = r.slug ?? 'unknown';
    if (r.active === false) {
      // a switched-off shop is never scraped, so it is not on the Shops page: say so, and why
      const why = r.note ? ` Reason: ${r.note}` : '';
      return { field: 'url', text: `This shop is already in the shop list (${slug}) but switched off, so it is not scraped or shown on the site.${why}` };
    }
    return { field: 'url', text: `This shop is already in the shop list (${slug}).` };
  }
  if (r.status === 409) {
    const now = r.current ? STATUS_LABELS[r.current] : 'open';
    return { field: 'url', text: `This address was already requested (now: ${now}). Use Retry or Reject in the list below.` };
  }
  if (r.status === 429) return { field: null, text: '20 shops are already waiting to be checked. Try again after the next check.' };
  if (r.status === 401) return { field: null, text: 'Your admin login has expired. Reload the page to sign in again.' };
  return { field: null, text: 'Something went wrong. Try again.' };
}

function AddShopForm({ onAdded }: { onAdded: (r: AdminShopRequest) => void }) {
  const id = useId();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({ url: null, name: null });
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const urlRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseShopAddress(url);
    const nameProblem = name.trim().length > NAME_MAX ? `Use at most ${NAME_MAX} characters.` : null;
    const next: FieldErrors = { url: parsed.ok ? null : ADDRESS_PROBLEM_TEXT[parsed.problem], name: nameProblem };
    setErrors(next);
    if (next.url || next.name) {
      setState({ kind: 'idle' });
      (next.url ? urlRef : nameRef).current?.focus();
      return;
    }
    setState({ kind: 'saving' });
    try {
      const res = await adminApi.createShopRequest({ url, name: name.trim() || null, category: category || null });
      if (res.ok) {
        setState({ kind: 'saved', text: `Added ${res.request.origin}. The PC checks new shops every 15 minutes.` });
        setUrl('');
        setName('');
        setCategory('');
        onAdded(res.request);
        return;
      }
      const refused = refusalText(res);
      if (refused.field === 'url' || refused.field === 'name') {
        setErrors({ url: refused.field === 'url' ? refused.text : null, name: refused.field === 'name' ? refused.text : null });
        setState({ kind: 'idle' });
        (refused.field === 'url' ? urlRef : nameRef).current?.focus();
      } else {
        setState({ kind: 'error', text: refused.text });
      }
    } catch (err) {
      setState({ kind: 'error', text: adminErrorText(err) });
    }
  };

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void submit(e)}>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-url`} className="text-sm font-semibold">
          Shop web address
        </label>
        <input
          ref={urlRef}
          id={`${id}-url`}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required
          aria-required="true"
          className={fieldClass}
          value={url}
          aria-invalid={errors.url !== null}
          aria-describedby={`${id}-url-hint`}
          onChange={(e) => setUrl(e.target.value)}
        />
        <p id={`${id}-url-hint`} className={errors.url ? 'text-sm font-medium text-bad' : 'text-xs text-muted-foreground'}>
          {errors.url ?? 'For example https://shop.com.mt. Only the address of the home page is kept.'}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-name`} className="text-sm font-semibold">
            Display name (optional)
          </label>
          <input
            ref={nameRef}
            id={`${id}-name`}
            type="text"
            autoComplete="off"
            className={fieldClass}
            value={name}
            maxLength={NAME_MAX + 20}
            aria-invalid={errors.name !== null}
            aria-describedby={`${id}-name-hint`}
            onChange={(e) => setName(e.target.value)}
          />
          <p id={`${id}-name-hint`} className={errors.name ? 'text-sm font-medium text-bad' : 'text-xs text-muted-foreground'}>
            {errors.name ?? "Left empty, the shop's own name is used."}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-category`} className="text-sm font-semibold">
            Shop category (optional)
          </label>
          <select id={`${id}-category`} className={fieldClass} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">No category</option>
            {SHOP_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" className="min-h-11" disabled={state.kind === 'saving'}>
          Add shop
        </Button>
        <SaveMessage state={state} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- list

function SetupDetails({ d }: { d: NonNullable<AdminShopRequest['details']> }) {
  const lines = [
    d.server && `Server: ${d.server}`,
    d.poweredBy && `Powered by: ${d.poweredBy}`,
    d.generator.length > 0 && `Generator: ${d.generator.join(', ')}`,
    `JSON-LD Product data: ${d.jsonLdProduct === null ? 'not checked (no product page found)' : d.jsonLdProduct ? 'yes' : 'no'}`,
    d.productPagesChecked.length > 0 && `Product pages read: ${d.productPagesChecked.join(', ')}`,
    d.categoryLinks.length > 0 && `Category links: ${d.categoryLinks.join(', ')}`,
    ...d.disallowed.map((x) => `robots.txt blocks the ${x.feed} feed: ${x.rule}`),
  ].filter((l): l is string => typeof l === 'string');
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">What was found</h3>
      <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-sm break-words">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function RequestItem({ request, onChanged }: { request: AdminShopRequest; onChanged: (r: AdminShopRequest) => void }) {
  const [state, run] = useSaver();
  const r = request;
  // rate limited by the shop: the PC checks it again by itself after this time
  const waitingAfterLimit = r.status === 'pending' && r.nextCheckAt !== null;
  const act = (status: 'pending' | 'rejected', text: string) =>
    void run(async () => {
      const { request: updated } = await adminApi.setShopRequestStatus(r.id, status);
      onChanged(updated);
    }, text);

  return (
    <li className="glass flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold break-all">{r.shop?.name ?? r.name ?? hostOf(r.origin)}</span>
        <StatusChip status={r.status} />
      </div>
      <p className="-mt-2 text-sm break-all text-muted-foreground">{r.origin}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Platform</dt>
        <dd>{r.platform ? (PLATFORM_LABELS[r.platform] ?? r.platform) : 'Not checked yet'}</dd>
        <dt className="text-muted-foreground">robots.txt</dt>
        <dd className="break-words">{robotsText(r.robots)}</dd>
        {r.productsFound !== null && (
          <>
            <dt className="text-muted-foreground">Products found</dt>
            <dd className="tabular-nums">{r.productsFound}</dd>
          </>
        )}
        {r.category && (
          <>
            <dt className="text-muted-foreground">Category</dt>
            <dd>{categoryLabel(r.category)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Added</dt>
        <dd>
          {when.format(new Date(r.requestedAt))}
          {r.source === 'visitor' ? ', suggested by a visitor' : ''}
        </dd>
        {r.checkedAt && (
          <>
            <dt className="text-muted-foreground">Checked</dt>
            <dd>
              {when.format(new Date(r.checkedAt))}
              {r.attempts > 1 ? ` (attempt ${r.attempts})` : ''}
            </dd>
          </>
        )}
        {r.shop && (
          <>
            <dt className="text-muted-foreground">Shop</dt>
            <dd>
              {r.shop.slug} ({r.shop.active ? 'scraped nightly' : 'not scraped'})
            </dd>
          </>
        )}
      </dl>
      {waitingAfterLimit ? (
        <p className="text-sm font-medium">Retrying after {when.format(new Date(r.nextCheckAt!))}</p>
      ) : (
        NEXT_STEP[r.status] && <p className="text-sm">{NEXT_STEP[r.status]}</p>
      )}
      {r.error && r.status !== 'checking' && (r.status !== 'pending' || waitingAfterLimit) && (
        <p className="rounded-md bg-secondary p-3 text-sm break-words whitespace-pre-wrap">{r.error}</p>
      )}
      {r.details && r.status === 'needs_setup' && <SetupDetails d={r.details} />}
      {r.sample.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">Sample products</h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {r.sample.map((s, i) => (
              <li key={i} className="flex flex-wrap gap-x-2 break-words">
                <span>{s.title ?? '(no title)'}</span>
                <span className="tabular-nums">{s.priceCents !== null && s.priceCents > 0 ? formatEuro(s.priceCents) : 'no price'}</span>
                {s.url && <span className="break-all text-muted-foreground">{s.url}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(RETRY_FROM.includes(r.status) || REJECT_FROM.includes(r.status)) && (
        <div className="flex flex-wrap items-center gap-2">
          {RETRY_FROM.includes(r.status) && (
            <Button className="min-h-11" disabled={state.kind === 'saving'} onClick={() => act('pending', 'Queued for the next check.')}>
              Retry<span className="sr-only">: {r.origin}</span>
            </Button>
          )}
          {REJECT_FROM.includes(r.status) && (
            <Button variant="outline" className="min-h-11" disabled={state.kind === 'saving'} onClick={() => act('rejected', 'Rejected.')}>
              Reject<span className="sr-only">: {r.origin}</span>
            </Button>
          )}
          <SaveMessage state={state} />
        </div>
      )}
    </li>
  );
}

type ListState = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; items: AdminShopRequest[] };

export function AdminAddShopPage() {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [announce, setAnnounce] = useState('');
  const alive = useRef(true);
  const lastStatus = useRef(new Map<number, ShopRequestStatus>());

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const { requests } = await adminApi.shopRequests(signal);
      if (!alive.current || signal?.aborted) return;
      // a refresh that changed a status says so once, for screen readers
      const changed = requests.filter((r) => lastStatus.current.has(r.id) && lastStatus.current.get(r.id) !== r.status);
      lastStatus.current = new Map(requests.map((r) => [r.id, r.status]));
      if (changed.length) setAnnounce(changed.map((r) => `${r.shop?.name ?? r.name ?? hostOf(r.origin)}: ${STATUS_LABELS[r.status]}.`).join(' '));
      setList({ status: 'ready', items: requests });
    } catch (error) {
      // a failed refresh keeps the list already shown
      if (alive.current && !signal?.aborted) setList((prev) => (prev.status === 'ready' ? prev : { status: 'error', error }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => {
      alive.current = false;
      ctrl.abort();
    };
  }, [load]);

  const busy = list.status === 'ready' && list.items.some((r) => r.status === 'pending' || r.status === 'checking');
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // no polling in a hidden tab; showing the tab again refreshes at once
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const changed = () => {
      const v = document.visibilityState !== 'hidden';
      setVisible(v);
      if (v && busyRef.current) void load();
    };
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, [load]);
  useEffect(() => {
    if (!busy || !visible) return;
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [busy, visible, load]);

  const remember = (r: AdminShopRequest) => lastStatus.current.set(r.id, r.status);
  const replace = (updated: AdminShopRequest) => {
    remember(updated);
    setList((prev) => (prev.status === 'ready' ? { status: 'ready', items: prev.items.map((r) => (r.id === updated.id ? updated : r)) } : prev));
  };
  const added = (r: AdminShopRequest) => {
    remember(r);
    setList((prev) => ({ status: 'ready', items: [r, ...(prev.status === 'ready' ? prev.items.filter((x) => x.id !== r.id) : [])] }));
  };

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Add a shop"
        description="The PC checks new addresses every 15 minutes: robots.txt, the platform (Shopify, WooCommerce or Magento), then a test scrape of 50 products at the usual polite pace. A shop that passes joins the nightly scrape on its own; other platforms are kept for a later setup."
      >
        <AddShopForm onAdded={added} />
      </Section>
      <Section title="Requests" description={busy ? 'This list refreshes every 30 seconds while a shop is waiting or being checked.' : undefined}>
        <p role="status" className="sr-only">
          {announce}
        </p>
        {list.status === 'loading' && <div role="status" aria-label="Loading requests" className="glass h-40 opacity-60" />}
        {list.status === 'error' && (
          <Notice
            title="Requests could not be loaded."
            action={
              <Button variant="outline" className="min-h-11" onClick={() => void load()}>
                Try again
              </Button>
            }
          >
            {adminErrorText(list.error)}
          </Notice>
        )}
        {list.status === 'ready' && list.items.length === 0 && <p className="text-sm text-muted-foreground">No shops requested yet.</p>}
        {list.status === 'ready' && list.items.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {list.items.map((r) => (
              <RequestItem key={r.id} request={r} onChanged={replace} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
