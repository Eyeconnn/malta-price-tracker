// Admin reports: visitor reports by status, newest first. Messages and emails are visitor input: text only.
import { useId, useState } from 'react';
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

/** The server's limit for admin notes (web/worker/admin.ts, MESSAGE_MAX). */
const NOTE_MAX = 1000;

const TARGETS: Record<string, string> = { product: 'Product', shop: 'Shop', match: 'Match' };

const when = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Malta' });

/** Buttons for every status but the current one. */
const ACTIONS: Record<ReportStatus, string> = { fixed: 'Mark fixed', kept: 'Keep as is', hidden: 'Hide', open: 'Reopen' };

function ReportItem({ report, onChanged }: { report: AdminReport; onChanged: () => void }) {
  const [note, setNote] = useState(report.adminNote ?? '');
  const [state, run] = useSaver();
  const id = useId();
  const label = report.target.label ?? `#${report.targetId}`;

  return (
    <li className="glass flex flex-col gap-3 p-4">
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
              if (await run(() => adminApi.updateReport(report.id, s.value, note))) onChanged();
            }}
          >
            {ACTIONS[s.value]}
          </Button>
        ))}
        <Button variant="ghost" className="min-h-11" disabled={state.kind === 'saving'} onClick={() => void run(() => adminApi.updateReport(report.id, report.status, note), 'Note saved.')}>
          Save note
        </Button>
        <SaveMessage state={state} />
      </div>
    </li>
  );
}

export function AdminReportsPage() {
  const [status, setStatus] = useState<ReportStatus>('open');
  const [page, setPage] = useState(1);
  const reports = useApi(`reports:${status}:${page}`, (signal) => adminApi.reports(status, page, signal));

  return (
    <Section title="Reports" description="What visitors flagged. Changing the status moves a report to that list.">
      <div role="group" aria-label="Status" className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <Button
            key={s.value}
            variant={s.value === status ? 'default' : 'outline'}
            aria-pressed={s.value === status}
            className="min-h-11"
            onClick={() => {
              setStatus(s.value);
              setPage(1);
            }}
          >
            {s.label}
          </Button>
        ))}
      </div>
      {(reports.status === 'loading' || reports.status === 'idle') && <div role="status" aria-label="Loading reports" className="glass h-40 opacity-60" />}
      {reports.status === 'error' && (
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
      {reports.status === 'ready' && (
        <>
          <p className="text-sm" aria-live="polite">
            {reports.data.total === 1 ? '1 report' : `${reports.data.total} reports`}
          </p>
          {reports.data.items.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {reports.data.items.map((r) => (
                <ReportItem key={`${r.id}:${r.status}`} report={r} onChanged={reports.retry} />
              ))}
            </ul>
          )}
          <Pager page={page} pageSize={reports.data.pageSize} total={reports.data.total} onPage={setPage} />
        </>
      )}
    </Section>
  );
}
