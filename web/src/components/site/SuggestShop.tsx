// "Missing a shop?" on /shops: a visitor suggests a shop's web address (POST /api/shop-suggestions, suggestions.ts).
// A known shop is answered at once (on the site, being checked, or why it cannot be tracked); a new one is queued
// for the PC check, which adds a shop that passes on its own. The answer is announced (role status).
import { type FormEvent, useId, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { api, type SuggestionAnswer, SuggestionError } from '@/lib/api';
import { ADDRESS_PROBLEM_TEXT, type AddressProblem, parseShopAddress } from '../../../../src/shop-requests/address.js';

export const SEND_FAILED = 'Your suggestion could not be sent. Please try again.';
export const QUEUE_FULL = 'Many shops are waiting to be checked right now. Please try again in a few hours.';

/** The 429 message; with a plausible retry-after (up to a day) it names the wait in whole hours, rounded up. */
export function suggestLimitText(retryAfterSec: number | null): string {
  const says = 'Several shops have been suggested from your network today.';
  if (retryAfterSec === null || !Number.isFinite(retryAfterSec) || retryAfterSec <= 0 || retryAfterSec > 86_400) return `${says} Please try again tomorrow.`;
  const hours = Math.ceil(retryAfterSec / 3600);
  return `${says} Please try again in about ${hours} ${hours === 1 ? 'hour' : 'hours'}.`;
}

type Shown = { answer: SuggestionAnswer; host: string } | { error: string };

function Answer({ answer, host }: { answer: SuggestionAnswer; host: string }) {
  switch (answer.outcome) {
    case 'listed':
      return (
        <>
          <p className="font-semibold">{answer.shop.name} is already on the site.</p>
          <Link to={`/shops/${encodeURIComponent(answer.shop.slug)}`} className="text-sm font-semibold text-ink underline underline-offset-2">
            See {answer.shop.name}
          </Link>
        </>
      );
    case 'queued':
      return (
        <>
          <p className="font-semibold">Thanks, we will check {host}.</p>
          <p className="text-sm text-muted-foreground">
            The check runs within about 15 minutes: we read the shop's robots.txt, find out how its shop works, then try a few of its
            pages at our usual slow pace. If it passes, it joins the nightly price checks and shows here after the next nightly update.
            Enter the address again later to see how the check went.
          </p>
        </>
      );
    case 'checking':
      return (
        <>
          <p className="font-semibold">{host} is already waiting to be checked.</p>
          <p className="text-sm text-muted-foreground">Look again in about 15 minutes to see how the check went.</p>
        </>
      );
    case 'known':
      return <p className="font-semibold">{host} is already on our list but is not shown on the site yet.</p>;
    case 'unavailable':
      return (
        <>
          <p className="font-semibold">
            We cannot track {host}: {answer.title.charAt(0).toLowerCase() + answer.title.slice(1)}.
          </p>
          <p className="text-sm text-muted-foreground">{answer.text}</p>
          <p className="text-sm text-muted-foreground">{answer.scope}</p>
        </>
      );
  }
}

export function SuggestShop() {
  const inputId = useId();
  const hintId = useId();
  const [address, setAddress] = useState('');
  const [sending, setSending] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    const parsed = parseShopAddress(address);
    if (!parsed.ok) {
      setShown({ error: ADDRESS_PROBLEM_TEXT[parsed.problem] });
      return;
    }
    setSending(true);
    setShown(null);
    try {
      const answer = await api.suggestShop({ url: address.trim(), name: null });
      setShown({ answer, host: parsed.host });
      if (answer.outcome === 'queued') setAddress('');
    } catch (err) {
      if (err instanceof SuggestionError && err.status === 400 && err.field === 'url' && err.reason && err.reason in ADDRESS_PROBLEM_TEXT) {
        setShown({ error: ADDRESS_PROBLEM_TEXT[err.reason as AddressProblem] });
      } else if (err instanceof SuggestionError && err.status === 429) setShown({ error: suggestLimitText(err.retryAfter) });
      else if (err instanceof SuggestionError && err.status === 503) setShown({ error: QUEUE_FULL });
      else setShown({ error: SEND_FAILED });
    } finally {
      setSending(false);
    }
  };

  const invalid = shown !== null && 'error' in shown;
  return (
    <section aria-labelledby={`${inputId}-title`} className="glass flex flex-col gap-3 p-[22px]">
      <h2 id={`${inputId}-title`} className="text-lg font-bold">
        Missing a shop?
      </h2>
      <p id={hintId} className="max-w-[760px] text-sm text-muted-foreground">
        Suggest a Maltese online shop by its web address. We check it automatically and add it if it can be tracked, or tell you
        why not.
      </p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-center gap-2" noValidate>
        <label htmlFor={inputId} className="sr-only">
          Shop web address
        </label>
        <input
          id={inputId}
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder="shop.com.mt"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          aria-describedby={hintId}
          aria-invalid={invalid || undefined}
          maxLength={2048}
          className="glass min-h-11 max-w-[480px] min-w-0 flex-[1_1_260px] rounded-full px-4 text-[15px] font-medium text-ink outline-none placeholder:text-faint focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Button type="submit" disabled={sending}>
          {sending ? 'Checking...' : 'Suggest shop'}
        </Button>
      </form>
      <div role="status" className="flex flex-col items-start gap-1.5">
        {shown && 'error' in shown && <p className="text-sm font-semibold text-bad">{shown.error}</p>}
        {shown && 'answer' in shown && <Answer answer={shown.answer} host={shown.host} />}
      </div>
    </section>
  );
}
