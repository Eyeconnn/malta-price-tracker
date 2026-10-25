// "Something wrong?": a button and dialog that send a visitor report to POST /api/reports (Task 15, Ruling R45).
// Radix Dialog moves focus in on open and back to the button on close; the thank-you message takes focus after sending.
import { Flag } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ApiError, api, type ReportReason, type ReportTarget } from '@/lib/api';
import { cn } from '@/lib/utils';

export const MESSAGE_MAX = 1000;
const EMAIL_MAX = 254;
/** The server's own pattern (web/worker/reports.ts). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The reasons offered per target, first one preselected. */
const REASONS: Record<ReportTarget, { value: ReportReason; label: string }[]> = {
  product: [
    { value: 'wrong-price', label: 'The price is wrong' },
    { value: 'not-black-friday', label: 'It is not a Black Friday deal' },
    { value: 'wrong-match', label: 'Another shop is matched to the wrong product' },
    { value: 'other', label: 'Something else' },
  ],
  match: [
    { value: 'wrong-match', label: 'It is not the same product' },
    { value: 'wrong-price', label: 'The price is wrong' },
    { value: 'other', label: 'Something else' },
  ],
  shop: [
    { value: 'wrong-price', label: 'A price is wrong' },
    { value: 'not-black-friday', label: 'A deal is not really Black Friday' },
    { value: 'other', label: 'Something else' },
  ],
};

const RATE_LIMIT_SAYS = 'Several reports have come from your network in the last hour.';
export const RATE_LIMITED = `${RATE_LIMIT_SAYS} Please try again later.`;

/** The 429 message; with a plausible retry-after (1 s to 1 hour) it names the wait in whole minutes, rounded up. */
export function rateLimitedText(retryAfterSec: number | null): string {
  if (retryAfterSec === null || !Number.isFinite(retryAfterSec) || retryAfterSec <= 0 || retryAfterSec > 3600) return RATE_LIMITED;
  const minutes = Math.ceil(retryAfterSec / 60);
  return `${RATE_LIMIT_SAYS} Please try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}
export const SEND_FAILED = 'Your report could not be sent. Please try again.';
export const EMAIL_NOTE = 'Only used to reply to you about this report.';
const EMAIL_BAD = 'Enter an email address like name@example.com, or leave it empty.';
const MESSAGE_BAD = `Details can be at most ${MESSAGE_MAX} characters.`;

type Status = 'editing' | 'sending' | 'sent';

const idList = (...ids: (string | false)[]) => ids.filter(Boolean).join(' ');

export type ReportButtonProps = {
  targetType: ReportTarget;
  /** products.id, shops.id, or for a match the other row's site_products.id (Ruling R20) */
  targetId: number;
  /** dialog title; also the button text unless `label` is given */
  title?: string;
  /** what the report is about, e.g. the product title, shown under the title */
  about?: string;
  /** visible button text, when it differs from the title */
  label?: string;
  /** accessible name of the button when the visible text alone is not enough (must contain the visible text) */
  ariaLabel?: string;
  compact?: boolean;
  className?: string;
};

export function ReportButton({ targetType, targetId, title = 'Something wrong?', about, label, ariaLabel, compact, className }: ReportButtonProps) {
  const reasons = REASONS[targetType];
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>(reasons[0]!.value);
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('editing');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: 'message' | 'email'; text: string } | null>(null);
  const attempt = useRef(0);
  const thanksRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const ids = { legend: useId(), message: useId(), counter: useId(), email: useId(), note: useId(), fieldError: useId() };

  useEffect(() => {
    if (status === 'sent') thanksRef.current?.focus();
  }, [status]);

  function onOpenChange(next: boolean) {
    if (next) {
      // a fresh form every time; an answer to an earlier attempt is ignored
      attempt.current++;
      setReason(reasons[0]!.value);
      setMessage('');
      setEmail('');
      setStatus('editing');
      setError(null);
      setFieldError(null);
    }
    setOpen(next);
  }

  function showFieldError(field: 'message' | 'email') {
    setFieldError({ field, text: field === 'email' ? EMAIL_BAD : MESSAGE_BAD });
    (field === 'email' ? emailRef : messageRef).current?.focus();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === 'sending') return;
    setError(null);
    setFieldError(null);
    const text = message.trim();
    const mail = email.trim();
    if (text.length > MESSAGE_MAX) return showFieldError('message');
    if (mail !== '' && (mail.length > EMAIL_MAX || !EMAIL.test(mail))) return showFieldError('email');

    const mine = ++attempt.current;
    setStatus('sending');
    try {
      await api.report({ targetType, targetId, reason, ...(text ? { message: text } : {}), ...(mail ? { email: mail } : {}) });
      if (mine === attempt.current) setStatus('sent');
    } catch (err) {
      if (mine !== attempt.current) return;
      setStatus('editing');
      const apiErr = err instanceof ApiError ? err : null;
      if (apiErr?.status === 400 && (apiErr.field === 'email' || apiErr.field === 'message')) showFieldError(apiErr.field);
      else setError(apiErr?.status === 429 ? rateLimitedText(apiErr.retryAfter) : SEND_FAILED);
    }
  }

  const field = 'w-full rounded-[10px] border border-line-strong bg-field px-3 py-2 text-[15px] font-medium text-ink outline-none placeholder:text-faint focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-bad';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant={compact ? 'ghost' : 'outline'}
          size={compact ? 'sm' : 'default'}
          className={cn('min-h-11 w-fit', compact && 'px-2.5 text-[13px] text-muted-foreground hover:text-ink', className)}
          aria-label={ariaLabel}
          data-report-target={`${targetType}:${targetId}`}
        >
          <Flag aria-hidden="true" />
          {label ?? title}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {about && <span className="block font-medium text-ink break-words">{about}</span>}
            {/* the intro belongs to the form; after sending only the thank-you message speaks */}
            {status !== 'sent' && 'Tell us what looks wrong and we will check it.'}
          </DialogDescription>
        </DialogHeader>

        {status === 'sent' ? (
          <div ref={thanksRef} tabIndex={-1} role="status" className="flex flex-col gap-3 rounded-sm outline-none">
            <p className="font-semibold">Thank you, your report has been sent.</p>
            <p className="text-sm text-muted-foreground">We check every report and correct the site when something is wrong.</p>
            <DialogClose asChild>
              <Button className="min-h-11 w-fit">Close</Button>
            </DialogClose>
          </div>
        ) : (
          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <p id={ids.legend} className="mb-1 text-sm font-semibold">
                What is wrong?
              </p>
              <div role="radiogroup" aria-labelledby={ids.legend} className="flex flex-col">
                {reasons.map((r) => (
                  <label key={r.value} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                    <input
                      type="radio"
                      name="reason"
                      value={r.value}
                      checked={reason === r.value}
                      onChange={() => setReason(r.value)}
                      className="size-4 shrink-0 accent-brand"
                    />
                    {r.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={ids.message} className="text-sm font-semibold">
                Details (optional)
              </label>
              <textarea
                id={ids.message}
                ref={messageRef}
                value={message}
                maxLength={MESSAGE_MAX}
                rows={4}
                onChange={(e) => setMessage(e.target.value)}
                aria-describedby={idList(ids.counter, fieldError?.field === 'message' && ids.fieldError)}
                aria-invalid={fieldError?.field === 'message' || undefined}
                className={cn(field, 'resize-y')}
              />
              <p id={ids.counter} className="text-right text-xs text-muted-foreground tabular-nums">
                {message.length} of {MESSAGE_MAX} characters
              </p>
              {fieldError?.field === 'message' && (
                <p id={ids.fieldError} className="text-sm font-medium text-bad">
                  {fieldError.text}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={ids.email} className="text-sm font-semibold">
                Email (optional)
              </label>
              <input
                id={ids.email}
                ref={emailRef}
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                maxLength={EMAIL_MAX}
                onChange={(e) => setEmail(e.target.value)}
                aria-describedby={idList(ids.note, fieldError?.field === 'email' && ids.fieldError)}
                aria-invalid={fieldError?.field === 'email' || undefined}
                className={cn(field, 'min-h-11')}
              />
              <p id={ids.note} className="text-xs text-muted-foreground">
                {EMAIL_NOTE}
              </p>
              {fieldError?.field === 'email' && (
                <p id={ids.fieldError} className="text-sm font-medium text-bad">
                  {fieldError.text}
                </p>
              )}
            </div>

            {error && (
              <p role="alert" className="rounded-md bg-secondary p-3 text-sm font-medium">
                {error}
              </p>
            )}

            <Button type="submit" className="min-h-11 w-fit" disabled={status === 'sending'}>
              {status === 'sending' ? 'Sending' : 'Send report'}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
