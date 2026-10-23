// Admin settings: the public switch (with a confirm dialog) and the category overrides editor.
import { useId, useState } from 'react';
import { CATEGORY_RULES, SITE_CATEGORIES } from '../../../../src/site/categories.js';
import { OVERRIDES_MAX, type SiteSettings, overrideKeyProblem } from '../../../../src/site/settings.js';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { adminApi } from '@/lib/admin-api';
import { useApi } from '@/lib/api';
import { SaveMessage, Section, WithSettings, fieldClass, useAdminSettings, useSaver } from './shared';

const categoryName = (slug: string) => SITE_CATEGORIES.find((c) => c.slug === slug)?.name ?? slug;

/** The text of the confirm dialog for switching the site to `toPublic`. */
export const PUBLIC_CONFIRM = {
  on: {
    title: 'Make the site public?',
    body: 'Everyone can open the site without a password, and search engines are allowed to index it. The admin area keeps its own password.',
    action: 'Make public',
  },
  off: {
    title: 'Make the site private?',
    body: 'Visitors need the site password again, and search engines are told not to index the site.',
    action: 'Make private',
  },
};
export const PROPAGATION_NOTE = 'The change applies at once on this server; other Cloudflare servers pick it up within 60 seconds.';

function PublicSwitch({ settings }: { settings: SiteSettings }) {
  const { save } = useAdminSettings();
  const [pending, setPending] = useState<boolean | null>(null);
  const [state, run] = useSaver();
  const id = useId();
  const text = pending === null ? null : pending ? PUBLIC_CONFIRM.on : PUBLIC_CONFIRM.off;

  return (
    <Section title="Site visibility" description={PROPAGATION_NOTE}>
      <div className="flex items-center gap-3">
        <Switch id={id} checked={settings.public} onCheckedChange={(v) => setPending(v)} aria-describedby={`${id}-state`} />
        <label htmlFor={id} className="font-semibold">
          Site is public
        </label>
      </div>
      <p id={`${id}-state`} className="text-sm">
        {settings.public ? 'Public: anyone can see the site and search engines may index it.' : 'Private: visitors need the site password; search engines are told not to index it.'}
      </p>
      <SaveMessage state={state} />
      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          {text && (
            <>
              <DialogHeader>
                <DialogTitle>{text.title}</DialogTitle>
                <DialogDescription>{text.body}</DialogDescription>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">{PROPAGATION_NOTE}</p>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline" className="min-h-11">
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  className="min-h-11"
                  onClick={() => {
                    const next = pending!;
                    setPending(null);
                    void run(() => save({ ...settings, public: next }), next ? 'The site is now public.' : 'The site is now private.');
                  }}
                >
                  {text.action}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function Rules() {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold">Built-in rules (read-only)</h3>
      <p className="text-sm text-muted-foreground">
        Tried in this order on the shop's category path, then tags, then the title. The title is used only for shops without a specialist category (electronics shops); other shops fall back to their own category. Rules marked "title first" are tried before the path. The first match wins; overrides are checked before all rules.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="py-2 pr-3 font-semibold">
                Category
              </th>
              <th scope="col" className="py-2 pr-3 font-semibold">
                Words
              </th>
              <th scope="col" className="py-2 font-semibold">
                Looks at
              </th>
            </tr>
          </thead>
          <tbody>
            {CATEGORY_RULES.map((r, i) => (
              <tr key={`${i}-${r.slug}`} className="border-b border-line align-top">
                <td className="py-2 pr-3 whitespace-nowrap">{categoryName(r.slug)}</td>
                <td className="py-2 pr-3">
                  <code className="text-xs break-all">{r.pattern.source}</code>
                </td>
                <td className="py-2">{r.first ? 'title first' : r.on.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One path segment, as categorize() compares it: trimmed and lowercased. */
function segmentsOf(path: string): string[] {
  return path
    .split(/>|\||\/|»|›/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function CategoryOverrides({ settings }: { settings: SiteSettings }) {
  const { save } = useAdminSettings();
  const [rows, setRows] = useState(() => Object.entries(settings.categoryOverrides));
  const [newKey, setNewKey] = useState('');
  const [newSlug, setNewSlug] = useState('other');
  const [state, run] = useSaver();
  const unmapped = useApi('admin-categories', (signal) => adminApi.categories(signal));
  const ids = useId();

  const key = newKey.trim().toLowerCase();
  const keyProblem = key === '' ? null : (overrideKeyProblem(key) ?? (rows.some(([k]) => k === key) ? 'This part already has an override.' : null));
  const canAdd = key !== '' && keyProblem === null && rows.length < OVERRIDES_MAX;

  return (
    <Section title="Categories" description="Overrides apply at the next site-build (nightly), not straight away.">
      <Rules />

      <div className="flex flex-col gap-2">
        <h3 className="font-semibold">Most common shop categories filed under Other</h3>
        <p className="text-sm text-muted-foreground">
          The shop's own category path (products.category_path) of each product's shown variant, for products now in Other. Pick a part to fill the
          override form.
        </p>
        {unmapped.status === 'error' && <p className="text-sm text-bad">The list could not be loaded.</p>}
        {(unmapped.status === 'loading' || unmapped.status === 'idle') && <p className="text-sm text-muted-foreground">Loading...</p>}
        {unmapped.status === 'ready' &&
          (unmapped.data.unmapped.length === 0 ? (
            <p className="text-sm">Nothing in Other has a shop category.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
              {unmapped.data.unmapped.map((u) => (
                <li key={u.path} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 break-words">{u.path}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{u.count} products</span>
                  <span className="flex flex-wrap gap-1">
                    {segmentsOf(u.path).map((s) => (
                      <Button key={s} variant="outline" size="sm" className="min-h-11" onClick={() => setNewKey(s)} aria-label={`Use "${s}" for a new override`}>
                        {s}
                      </Button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          ))}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="font-semibold">Overrides</h3>
        <p className="text-sm text-muted-foreground">
          A part of a shop's category path (for example "small appliances") always goes to the chosen category. {rows.length} of {OVERRIDES_MAX} used.
        </p>
        {rows.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {rows.map(([k, slug], i) => (
              <li key={k} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 break-words font-medium">{k}</span>
                <label className="sr-only" htmlFor={`${ids}-o${i}`}>
                  Category for {k}
                </label>
                <select
                  id={`${ids}-o${i}`}
                  className={`${fieldClass} w-auto`}
                  value={slug}
                  onChange={(e) => setRows(rows.map((r, j) => (j === i ? [k, e.target.value] : r)))}
                >
                  {SITE_CATEGORIES.map((c) => (
                    <option key={c.slug} value={c.slug}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <Button variant="outline" className="min-h-11" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove override for ${k}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <label htmlFor={`${ids}-key`} className="text-sm font-semibold">
              Shop category part
            </label>
            <input
              id={`${ids}-key`}
              className={fieldClass}
              value={newKey}
              maxLength={200}
              onChange={(e) => setNewKey(e.target.value)}
              aria-invalid={keyProblem !== null}
              aria-describedby={keyProblem ? `${ids}-keyerr` : undefined}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-slug`} className="text-sm font-semibold">
              Category
            </label>
            <select id={`${ids}-slug`} className={`${fieldClass} w-auto`} value={newSlug} onChange={(e) => setNewSlug(e.target.value)}>
              {SITE_CATEGORIES.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={!canAdd}
            onClick={() => {
              setRows([...rows, [key, newSlug]]);
              setNewKey('');
            }}
          >
            Add override
          </Button>
        </div>
        {keyProblem && (
          <p id={`${ids}-keyerr`} className="text-sm font-medium text-bad">
            {keyProblem}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button className="min-h-11" disabled={state.kind === 'saving'} onClick={() => void run(() => save({ ...settings, categoryOverrides: Object.fromEntries(rows) }))}>
            Save overrides
          </Button>
          <SaveMessage state={state} />
        </div>
      </div>
    </Section>
  );
}

export function AdminSettingsPage() {
  return (
    <WithSettings>
      {(settings) => (
        <div className="flex flex-col gap-4">
          <PublicSwitch settings={settings} />
          <CategoryOverrides settings={settings} />
        </div>
      )}
    </WithSettings>
  );
}
