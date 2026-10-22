// Admin reports: visitor reports by status, newest first. Messages and emails are visitor input: text only.
// A status change updates the list in place (no reload): the changed report leaves the list with a status
// message, the others stay mounted so notes typed in them are kept, and focus moves to the next report.
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Notice } from '@/components/site/DealList';
import { Button } from '@/components/ui/button';
import { type AdminReport, type ReportStatus, adminApi, adminErrorText } from '@/lib/admin-api';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Pager, SaveMessage, Section, fieldClass, useSaver } from './shared';

const STATUSES: { value: ReportStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'kept', label: 'Kept' },
  { value: 'hidden', label: 'Hidden' },
];

const REASONS: Record<string, string> = {
  'wrong-price': 'Wrong price',
  'wrong-match': 'Wrong match',
  'not-black-friday': 'Not a Black Friday deal',
  other: 'Something else',
};

/** The server's limit for admin notes (MESSAGE_MAX in web/worker/reports.ts, applied by web/worker/admin.ts). */
const NOTE_MAX = 1000;

const TARGETS: Record<string, string> = { product: 'Product', shop: 'Shop', match: 'Match' };

const when = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Malta' });

/** Buttons for every status but the current one. */
const ACTIONS: Record<ReportStatus, string> = { fixed: 'Mark fixed', kept: 'Keep as is', hidden: 'Hide', open: 'Reopen' };

const statusLabel = (s: ReportStatus) => STATUSES.find((x) => x.value === s)!.label;
const itemId = (id: number) => `admin-report-${id}`;

/** One report; onChanged gets the stored report after a PATCH. */
function ReportItem({ report, onChanged }: { report: AdminReport; onChanged: (updated: AdminReport) => void }) {
  const [note, setNote] = useState(report.adminNote ?? '');
  const [state, run] = useSaver();
  const id = useId();
  const label = report.target.label ?? `#${report.targetId}`;

  return (
    <li id={itemId(report.id)} tabIndex={-1} className="glass flex flex-col gap-3 p-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{TARGETS[report.targetType] ?? report.targetType}</span>
        {report.target.link ? (
          <Link to={report.target.link} className="font-semibold break-words text-brand underline-offset-4 hover:underline">
            {label}
          </Link>
        ) : (
          <span className="font-semibold break-words">
            {label} <span className="font-normal text-muted-foreground">(no longer on the site)</span>
          </span>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Reason</dt>
        <dd>{report.reason ? (REASONS[report.reason] ?? report.reason) : 'None given'}</dd>
        <dt className="text-muted-foreground">Sent</dt>
        <dd>{when.format(new Date(report.createdAt))}</dd>
        <dt className="text-muted-foreground">Email</dt>
        <dd className="break-all">{report.email ?? 'None'}</dd>
        {report.resolvedAt && (
          <>
            <dt className="text-muted-foreground">Resolved</dt>
            <dd>{when.format(new Date(report.resolvedAt))}</dd>
          </>
        )}
      </dl>
      {report.message && <p className="rounded-md bg-secondary p-3 text-sm break-words whitespace-pre-wrap">{report.message}</p>}
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm font-semibold">
          Admin note (optional)
        </label>
        <textarea id={id} className={cn(fieldClass, 'min-h-20')} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.filter((s) => s.value !== report.status).map((s) => (
          <Button
            key={s.value}
            variant={s.value === 'fixed' ? 'default' : 'outline'}
            className="min-h-11"
            disabled={state.kind === 'saving'}
            onClick={async () => {
              let updated: AdminReport | null = null;
              if (await run(async () => void (updated = (await adminApi.updateReport(report.id, s.value, note)).report))) onChanged(updated!);
            }}
          >
            {ACTIONS[s.value]}
          </Button>
        ))}
        <Button variant="ghost" className="min-h-11" disabled={state.kind === 'saving'} onClick={async () => {
            let updated: AdminReport | null = null;
            if (await run(async () => void (updated = (await adminApi.updateReport(report.id, report.status, note)).report), 'Note saved.')) onChanged(updated!);
          }}>
          Save note
        </Button>
        <SaveMessage state={state} />
      </div>
    </li>
  );
}

type Local = { key: string; items: AdminReport[]; total: number };

export function AdminReportsPage() {
  const [status, setStatus] = useState<ReportStatus>('open');
  const [page, setPage] = useState(1);
  const key = `reports:${status}:${page}`;
  const reports = useApi(key, (signal) => adminApi.reports(status, page, signal));
  // the loaded page with local changes applied; dropped when the filter or page changes
  const [local, setLocal] = useState<Local | null>(null);
  const [announce, setAnnounce] = useState('');
  const [focusTo, setFocusTo] = useState<number | 'heading' | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const view: Local | null = local?.key === key ? local : reports.status === 'ready' ? { key, items: reports.data.items, total: reports.data.total } : null;

  useEffect(() => {
    if (focusTo === null) return;
    (focusTo === 'heading' ? headingRef.current : document.getElementById(itemId(focusTo)))?.focus();
    setFocusTo(null);
  }, [focusTo]);

  const changed = (updated: AdminReport) => {
    if (!view) return;
    const index = view.items.findIndex((r) => r.id === updated.id);
    if (updated.status === status) {
      setLocal({ ...view, items: view.items.map((r) => (r.id === updated.id ? updated : r)) });
      return;
    }
    const items = view.items.filter((r) => r.id !== updated.id);
    setLocal({ key, items, total: Math.max(0, view.total - 1) });
    setAnnounce(`Report ${updated.id} marked ${statusLabel(updated.status).toLowerCase()} and moved to the ${statusLabel(updated.status)} list.`);
    const next = items[index] ?? items[index - 1];
    setFocusTo(next ? next.id : 'heading');
  };

  const choose = (s: ReportStatus, p: number) => {
    setStatus(s);
    setPage(p);
    setLocal(null);
    setAnnounce('');
  };

  return (
    <Section title="Reports" description="What visitors flagged. Changing the status moves a report to that list.">
      <div role="group" aria-label="Status" className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <Button key={s.value} variant={s.value === status ? 'default' : 'outline'} aria-pressed={s.value === status} className="min-h-11" onClick={() => choose(s.value, 1)}>
            {s.label}
          </Button>
        ))}
      </div>
      <p role="status" className="min-h-5 text-sm font-medium">
        {announce}
      </p>
      {!view && (reports.status === 'loading' || reports.status === 'idle') && <div role="status" aria-label="Loading reports" className="glass h-40 opacity-60" />}
      {!view && reports.status === 'error' && (
        <Notice
          title="Reports could not be loaded."
          action={
            <Button variant="outline" className="min-h-11" onClick={reports.retry}>
              Try again
            </Button>
          }
        >
          {adminErrorText(reports.error)}
        </Notice>
      )}
      {view && (
        <>
          <h3 ref={headingRef} tabIndex={-1} className="rounded-sm font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {statusLabel(status)} reports: {view.total}
          </h3>
          {view.items.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {view.items.map((r) => (
                <ReportItem key={r.id} report={r} onChanged={changed} />
              ))}
            </ul>
          )}
          <Pager page={page} pageSize={reports.status === 'ready' ? reports.data.pageSize : 50} total={view.total} onPage={(p) => choose(status, p)} />
        </>
      )}
    </Section>
  );
}
