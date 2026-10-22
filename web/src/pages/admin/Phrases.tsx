// Admin phrases: the home page headline lines per time slot, with a live preview of the *highlight* markup.
import { useId, useState } from 'react';
import { PHRASES_PER_SLOT_MAX, PHRASE_MAX, PHRASE_SLOTS, type PhraseSlot, type SiteSettings, phraseProblem } from '../../../../src/site/settings.js';
import { parseHighlight } from '@/components/site/Headline';
import { Button } from '@/components/ui/button';
import { SaveMessage, Section, WithSettings, fieldClass, useAdminSettings, useSaver } from './shared';

export const SLOT_LABELS: Record<PhraseSlot, { name: string; when: string }> = {
  morning: { name: 'Morning', when: '06:00 to 11:59 Malta time' },
  afternoon: { name: 'Afternoon', when: '12:00 to 17:59 Malta time' },
  evening: { name: 'Evening', when: '18:00 to 23:59 Malta time' },
  late: { name: 'Late night', when: '00:00 to 05:59 Malta time' },
  bfweek: { name: 'Black Friday week', when: 'all day, 20 to 27 November; {days} becomes the days left, such as "5 days"' },
};

/** A phrase as the home page shows it, highlights in bold (text only, never HTML). */
function Preview({ line }: { line: string }) {
  return (
    <span>
      {parseHighlight(line.replaceAll('{days}', '5 days')).map((s, i) =>
        s.em ? (
          <strong key={i} className="text-brand">
            {s.text}
          </strong>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  );
}

function SlotEditor({ slot, lines, onChange }: { slot: PhraseSlot; lines: string[]; onChange: (lines: string[]) => void }) {
  const id = useId();
  const label = SLOT_LABELS[slot];
  return (
    <fieldset className="flex flex-col gap-3 border-t border-line pt-4">
      <legend className="font-semibold">
        {label.name} <span className="font-normal text-muted-foreground">({label.when})</span>
      </legend>
      {lines.map((line, i) => {
        const problem = phraseProblem(line, slot);
        const fid = `${id}-${i}`;
        return (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <label htmlFor={fid} className="sr-only">
                {label.name} line {i + 1}
              </label>
              <input
                id={fid}
                className={fieldClass}
                value={line}
                maxLength={PHRASE_MAX + 20}
                aria-invalid={problem !== null}
                aria-describedby={`${fid}-hint`}
                onChange={(e) => onChange(lines.map((l, j) => (j === i ? e.target.value : l)))}
              />
              <Button
                variant="outline"
                className="min-h-11"
                disabled={lines.length <= 1}
                aria-label={`Remove ${label.name} line ${i + 1}`}
                onClick={() => onChange(lines.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
            <p id={`${fid}-hint`} className={problem ? 'text-sm font-medium text-bad' : 'text-sm text-muted-foreground'}>
              {problem ?? <Preview line={line.trim()} />}
            </p>
          </div>
        );
      })}
      <Button variant="outline" className="min-h-11 w-fit" disabled={lines.length >= PHRASES_PER_SLOT_MAX} onClick={() => onChange([...lines, ''])}>
        Add a {label.name.toLowerCase()} line
      </Button>
    </fieldset>
  );
}

function PhraseForm({ settings }: { settings: SiteSettings }) {
  const { save } = useAdminSettings();
  const [phrases, setPhrases] = useState(settings.phrases);
  const [state, run] = useSaver();
  const problems = PHRASE_SLOTS.reduce((n, slot) => n + phrases[slot].filter((l) => phraseProblem(l, slot) !== null).length, 0);

  return (
    <Section
      title="Headline phrases"
      description={
        <>
          One line is picked per visit from the current time slot. Put *stars* around words to highlight them. Each line needs 3 to {PHRASE_MAX} characters;
          each slot keeps 1 to {PHRASES_PER_SLOT_MAX} lines. The home page shows changes within 10 minutes (its answer is cached).
        </>
      }
    >
      {PHRASE_SLOTS.map((slot) => (
        <SlotEditor key={slot} slot={slot} lines={phrases[slot]} onChange={(lines) => setPhrases({ ...phrases, [slot]: lines })} />
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button className="min-h-11" disabled={problems > 0 || state.kind === 'saving'} onClick={() => void run(() => save({ ...settings, phrases }))}>
          Save phrases
        </Button>
        {problems > 0 && <p className="text-sm font-medium text-bad">Fix {problems === 1 ? '1 line' : `${problems} lines`} before saving.</p>}
        <SaveMessage state={state} />
      </div>
    </Section>
  );
}

export function AdminPhrasesPage() {
  return <WithSettings>{(settings) => <PhraseForm settings={settings} />}</WithSettings>;
}
