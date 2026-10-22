// Admin matches (Ruling R30): products linked across shops by title only. Each member gets a checkbox; the site
// claims "cheaper elsewhere" between two of them only when both rows are confirmed.
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { Notice } from '@/components/site/DealList';
import { Button } from '@/components/ui/button';
import { type MatchGroup, adminApi, adminErrorText } from '@/lib/admin-api';
import { useApi } from '@/lib/api';
import { formatEuro } from '@/lib/format';
import { Pager, SaveMessage, Section, useSaver } from './shared';

type Member = MatchGroup['members'][number];

function MemberRow({ member }: { member: Member }) {
  const [confirmed, setConfirmed] = useState(member.confirmed);
  const [state, run] = useSaver();
  const id = useId();
  return (
    <li className="flex flex-wrap items-center gap-3 py-2">
      <input
        id={id}
        type="checkbox"
        className="size-5 shrink-0 accent-brand"
        checked={confirmed}
        disabled={state.kind === 'saving'}
        onChange={async (e) => {
          const v = e.target.checked;
          if (await run(() => adminApi.confirmMatch(member.id, v), v ? 'Confirmed.' : 'Unconfirmed.')) setConfirmed(v);
        }}
      />
      <label htmlFor={id} className="min-w-0 flex-1 break-words">
        <span className="font-semibold">{member.shop}</span>: {member.title}
        <span className="ml-2 text-sm text-muted-foreground tabular-nums">{member.priceCents === null ? 'No price shown' : formatEuro(member.priceCents)}</span>
      </label>
      <Link to={`/p/${member.id}`} className="text-sm text-brand underline-offset-4 hover:underline">
        Open<span className="sr-only"> {member.title} at {member.shop}</span>
      </Link>
      <SaveMessage state={state} />
    </li>
  );
}

export function AdminMatchesPage() {
  const [pendingOnly, setPendingOnly] = useState(true);
  const [page, setPage] = useState(1);
  const matches = useApi(`matches:${pendingOnly}:${page}`, (signal) => adminApi.matches(pendingOnly, page, signal));
  const toggleId = useId();

  return (
    <Section
      title="Title matches"
      description="Products linked across shops by title only. Tick each row that really is the same product; a cheaper-elsewhere claim needs both rows confirmed."
    >
      <div className="flex items-center gap-2">
        <input
          id={toggleId}
          type="checkbox"
          className="size-5 accent-brand"
          checked={pendingOnly}
          onChange={(e) => {
            setPendingOnly(e.target.checked);
            setPage(1);
          }}
        />
        <label htmlFor={toggleId} className="text-sm font-semibold">
          Only groups waiting for confirmation
        </label>
      </div>
      {(matches.status === 'loading' || matches.status === 'idle') && <div role="status" aria-label="Loading matches" className="glass h-40 opacity-60" />}
      {matches.status === 'error' && (
        <Notice
          title="Matches could not be loaded."
          action={
            <Button variant="outline" className="min-h-11" onClick={matches.retry}>
              Try again
            </Button>
          }
        >
          {adminErrorText(matches.error)}
        </Notice>
      )}
      {matches.status === 'ready' && (
        <>
          <p className="text-sm">{matches.data.total === 1 ? '1 group' : `${matches.data.total} groups`}</p>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {matches.data.groups.map((g) => (
              <li key={g.canonicalId} className="glass px-4 py-2">
                <h3 className="sr-only">Group {g.canonicalId}</h3>
                <ul className="m-0 list-none divide-y divide-line p-0">
                  {g.members.map((m) => (
                    <MemberRow key={m.id} member={m} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <Pager page={page} pageSize={matches.data.pageSize} total={matches.data.total} onPage={setPage} />
        </>
      )}
    </Section>
  );
}
