import { optionalEnv } from './env.js';

/** Sends a plain-text email through Resend. Without RESEND_API_KEY / ALERT_EMAIL it prints instead. */
export async function sendEmail(subject: string, text: string): Promise<void> {
  const key = optionalEnv('RESEND_API_KEY');
  const to = optionalEnv('ALERT_EMAIL');
  if (!key || !to) {
    console.log(`\n=== email (not sent: RESEND_API_KEY or ALERT_EMAIL missing) ===\n${subject}\n\n${text}\n`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: optionalEnv('ALERT_FROM') ?? 'Malta Price Tracker <onboarding@resend.dev>',
      to: to.split(',').map((s) => s.trim()),
      subject,
      text,
    }),
  });
  if (!res.ok) console.error(`Resend error ${res.status}: ${await res.text()}`);
  else console.log(`email sent: ${subject}`);
}
