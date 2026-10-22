// Admin thresholds: the numbers that judge deals and rate shops, within the ranges the Worker accepts.
import { useId, useState } from 'react';
import { type SiteSettings, THRESHOLD_LIMITS, type Thresholds } from '../../../../src/site/settings.js';
import { Button } from '@/components/ui/button';
import { SaveMessage, Section, WithSettings, fieldClass, useAdminSettings, useSaver } from './shared';

export const THRESHOLD_TEXT: Record<keyof Thresholds, { label: string; unit: string; help: string }> = {
  minHistoryDays: { label: 'Days of history before judging', unit: 'days', help: 'A product needs this many days of prices before it gets a verdict.' },
  baselineDays: { label: 'Baseline window', unit: 'days', help: 'The earlier lowest price is taken over up to this many days before the current price started.' },
  raiseWindowDays: { label: 'Recent rise window', unit: 'days', help: 'A price or was price raised within this many days counts as raised before the sale.' },
  raisePct: { label: 'Rise that counts', unit: '%', help: 'A rise smaller than this is ignored.' },
  goodDropPct: { label: 'Drop for a good deal', unit: '%', help: 'A good deal is at least this far below that earlier lowest price.' },
  cheaperPct: { label: 'Cheaper elsewhere', unit: '%', help: 'Another shop is shown as cheaper when at least this much lower.' },
  minJudgedForRating: { label: 'Judged products for a rating', unit: 'products', help: 'A shop gets a letter only with at least this many judged products.' },
};

const KEYS = Object.keys(THRESHOLD_LIMITS) as (keyof Thresholds)[];

/** Why a typed value cannot be saved for `key`, or null. */
export function thresholdProblem(key: keyof Thresholds, raw: string): string | null {
  const { min, max, integer } = THRESHOLD_LIMITS[key];
  const n = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return `Use a number from ${min} to ${max}.`;
  if (integer && !Number.isInteger(n)) return 'Use a whole number.';
  return null;
}

function ThresholdForm({ settings }: { settings: SiteSettings }) {
  const { save } = useAdminSettings();
  const [values, setValues] = useState(() => Object.fromEntries(KEYS.map((k) => [k, String(settings.thresholds[k])])) as Record<keyof Thresholds, string>);
  const [state, run] = useSaver();
  const id = useId();
  const invalid = KEYS.some((k) => thresholdProblem(k, values[k]) !== null);

  return (
    <Section
      title="Thresholds"
      description="Verdicts and shop ratings use these at the next site-build (nightly). Cheaper-elsewhere and the history days note use them once cached pages refresh, within 10 minutes."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {KEYS.map((k) => {
          const { min, max, integer } = THRESHOLD_LIMITS[k];
          const text = THRESHOLD_TEXT[k];
          const problem = thresholdProblem(k, values[k]);
          const fid = `${id}-${k}`;
          return (
            <div key={k} className="flex flex-col gap-1">
              <label htmlFor={fid} className="text-sm font-semibold">
                {text.label} ({text.unit})
              </label>
              <input
                id={fid}
                type="number"
                inputMode={integer ? 'numeric' : 'decimal'}
                min={min}
                max={max}
                step={integer ? 1 : 0.1}
                className={fieldClass}
                value={values[k]}
                aria-invalid={problem !== null}
                aria-describedby={`${fid}-hint`}
                onChange={(e) => setValues({ ...values, [k]: e.target.value })}
              />
              <p id={`${fid}-hint`} className={problem ? 'text-sm font-medium text-bad' : 'text-xs text-muted-foreground'}>
                {problem ?? `${text.help} ${min} to ${max}.`}
              </p>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          className="min-h-11"
          disabled={invalid || state.kind === 'saving'}
          onClick={() => void run(() => save({ ...settings, thresholds: Object.fromEntries(KEYS.map((k) => [k, Number(values[k])])) as Thresholds }))}
        >
          Save thresholds
        </Button>
        <SaveMessage state={state} />
      </div>
    </Section>
  );
}

export function AdminThresholdsPage() {
  return <WithSettings>{(settings) => <ThresholdForm settings={settings} />}</WithSettings>;
}
