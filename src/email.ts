import nodemailer from 'nodemailer';
import { optionalEnv } from './env.js';

/** Recipients: ALERT_EMAIL (comma separated), else the Gmail account itself. */
function recipients(): string[] {
  const list = optionalEnv('ALERT_EMAIL') ?? optionalEnv('GMAIL_USER') ?? '';
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith('@example.com'));
}

/**
 * Sends a plain-text email. Gmail SMTP (GMAIL_USER + GMAIL_APP_PASSWORD, an app password from the
 * Google account's security settings) is used when set, Resend (RESEND_API_KEY) otherwise. With
 * neither, or no recipient, the email is printed instead.
 */
export async function sendEmail(subject: string, text: string): Promise<void> {
  const to = recipients();
  const gmailUser = optionalEnv('GMAIL_USER');
  const gmailPass = optionalEnv('GMAIL_APP_PASSWORD');
  const resendKey = optionalEnv('RESEND_API_KEY');

  if (to.length && gmailUser && gmailPass) {
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: gmailUser, pass: gmailPass.replace(/\s+/g, '') },
    });
    try {
      await transport.sendMail({ from: `Price tracker <${gmailUser}>`, to, subject, text });
      console.log(`email sent: ${subject}`);
    } catch (e) {
      console.error(`Gmail SMTP error: ${(e as Error).message}`);
      console.log(`\n=== email (not sent) ===\n${subject}\n\n${text}\n`);
    }
    return;
  }

  if (to.length && resendKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: optionalEnv('ALERT_FROM') ?? 'Price tracker <onboarding@resend.dev>',
        to,
        subject,
        text,
      }),
    });
    if (!res.ok) console.error(`Resend error ${res.status}: ${await res.text()}`);
    else console.log(`email sent: ${subject}`);
    return;
  }

  console.log(`\n=== email (not sent: no mail settings or recipient) ===\n${subject}\n\n${text}\n`);
}
