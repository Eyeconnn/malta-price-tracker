// POST /api/reports: "Something wrong?" reports from visitors, the site's only public write path (Ruling R45).
// Checks in order: Origin (403), content-type (415), body size (413), JSON shape and fields (400), Turnstile when a
// secret is set (400), then the rate limit and insert (429 / 201). Writes use the site_reporter role only
// (Ruling R7: insert on reports, select (ip_hash, created_at); no RETURNING). Responses are never cached.
import { neon } from '@neondatabase/serverless';
import type { Statement } from './data.js';
import type { Env } from './env.js';
import { json } from './http.js';

export const REPORT_TARGETS = ['product', 'shop', 'match'] as const;
export const REPORT_REASONS = ['wrong-price', 'wrong-match', 'not-black-friday', 'other'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];
export type ReportReason = (typeof REPORT_REASONS)[number];

/** The JSON body of POST /api/reports. targetId: products.id, shops.id or (match) the other row's site_products.id (R20). */
export type ReportBody = {
  targetType: ReportTarget;
  targetId: number;
  reason: ReportReason;
  message?: string;
  email?: string;
  turnstileToken?: string;
};

export const REPORTS_PER_HOUR = 5;
export const MESSAGE_MAX = 1000;
export const EMAIL_MAX = 254;
const BODY_MAX = 8 * 1024;
const TOKEN_MAX = 2048;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** First key of the per-IP advisory lock, so it cannot meet another feature's locks. */
const LOCK_CLASS = 4515;

/** A validated report, ready to insert. message and email are null when absent. */
export type NewReport = {
  targetType: ReportTarget;
  targetId: number;
  reason: ReportReason;
  message: string | null;
  email: string | null;
  ipHash: string;
};

export type InsertResult = { ok: true } | { ok: false; retryAfter: number };

export interface ReportStore {
  /** Inserts unless the ip hash already has `limit` reports in the last hour; retryAfter in seconds. */
  insertLimited(report: NewReport, limit: number): Promise<InsertResult>;
}

/** Runs statements in one read-write transaction. */
export interface WriteRunner {
  transaction(statements: Statement[]): Promise<Record<string, unknown>[][]>;
}

export interface ReportDeps {
  store: (env: Env) => ReportStore;
  /** fetch for Turnstile siteverify; defaults to the global fetch */
  fetch?: typeof fetch;
}

/**
 * One transaction: a per-IP advisory lock (so parallel requests from one client cannot all pass the count), the
 * count of the last hour, and an insert that only happens while the count is under the limit. Only ip_hash and
 * created_at are read, and the insert has no RETURNING (the role cannot select id).
 */
export function createReportStore(db: WriteRunner): ReportStore {
  return {
    async insertLimited(r, limit) {
      const window = `from reports where ip_hash = $1::text and created_at > now() - interval '1 hour'`;
      const [, counted] = await db.transaction([
        { text: `select pg_advisory_xact_lock(${LOCK_CLASS}, hashtext($1::text))`, params: [r.ipHash] },
        {
          text: `select count(*)::int as n, ceil(extract(epoch from (min(created_at) + interval '1 hour' - now())))::int as retry ${window}`,
          params: [r.ipHash],
        },
        {
          text: `insert into reports (target_type, target_id, reason, message, email, ip_hash)
            select $2::text, $3::bigint, $4::text, $5::text, $6::text, $1::text
            where (select count(*) ${window}) < $7::int`,
          params: [r.ipHash, r.targetType, r.targetId, r.reason, r.message, r.email, limit],
        },
      ]);
      const row = counted[0] ?? {};
      if (Number(row.n) < limit) return { ok: true };
      return { ok: false, retryAfter: Math.max(1, Number(row.retry) || 1) };
    },
  };
}

export function neonReportStore(databaseUrl: string): ReportStore {
  const sql = neon(databaseUrl);
  return createReportStore({
    transaction: (statements) => sql.transaction(statements.map((s) => sql.query(s.text, s.params))) as Promise<Record<string, unknown>[][]>,
  });
}

export const DEFAULT_REPORTS: ReportDeps = { store: (env) => neonReportStore(env.REPORTER_DATABASE_URL) };

const bad = (field: string) => json({ error: field }, 400);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Control characters other than tab and newline removed, lone surrogates replaced, trimmed; null when empty. */
function cleanText(v: string): string | null {
  const s = v
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')
    .trim();
  return s === '' ? null : s;
}

/** An optional text field: absent, null or blank gives null; a non-string gives undefined (invalid). */
function optionalText(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  return cleanText(v);
}

type Valid = { report: Omit<NewReport, 'ipHash'>; token: string | null };

/** The report in a parsed body, or the name of the first bad field. Unknown keys are ignored. */
export function validateReport(body: unknown): Valid | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'body' };
  const b = body as Record<string, unknown>;
  if (!REPORT_TARGETS.includes(b.targetType as ReportTarget)) return { error: 'targetType' };
  if (typeof b.targetId !== 'number' || !Number.isSafeInteger(b.targetId) || b.targetId <= 0) return { error: 'targetId' };
  if (!REPORT_REASONS.includes(b.reason as ReportReason)) return { error: 'reason' };
  const message = optionalText(b.message);
  if (message === undefined || (message !== null && message.length > MESSAGE_MAX)) return { error: 'message' };
  const email = optionalText(b.email);
  if (email === undefined || (email !== null && (email.length > EMAIL_MAX || !EMAIL.test(email)))) return { error: 'email' };
  const token = optionalText(b.turnstileToken);
  if (token === undefined || (token !== null && token.length > TOKEN_MAX)) return { error: 'turnstileToken' };
  return {
    report: { targetType: b.targetType as ReportTarget, targetId: b.targetId, reason: b.reason as ReportReason, message, email },
    token,
  };
}

/** Lowercase hex SHA-256 of IP_SALT + the client IP. */
export async function ipHash(salt: string, ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ip));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function originAllowed(req: Request, env: Env, url: URL): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  let site: string | null = null;
  try {
    site = new URL(env.SITE_ORIGIN).origin;
  } catch {
    // SITE_ORIGIN unset or malformed: only the request's own origin counts
  }
  return origin === url.origin || origin === site;
}

/** The body as text, or null when it is longer than BODY_MAX bytes (read in chunks, never buffered past the cap). */
async function readCapped(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > BODY_MAX) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function turnstileOk(secret: string, token: string, ip: string | null, doFetch: typeof fetch): Promise<boolean> {
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set('remoteip', ip);
  const res = await doFetch(SITEVERIFY, { method: 'POST', body: form });
  if (!res.ok) return false;
  const out = (await res.json()) as { success?: unknown };
  return out.success === true;
}

/** Handles /api/reports (any method). */
export async function handleReport(req: Request, env: Env, url: URL, deps: ReportDeps): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
  if (!originAllowed(req, env, url)) return json({ error: 'forbidden' }, 403);
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return json({ error: 'content-type' }, 415);

  const text = await readCapped(req);
  if (text === null) return json({ error: 'too large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad('body');
  }
  const valid = validateReport(body);
  if ('error' in valid) return bad(valid.error);

  const ip = req.headers.get('cf-connecting-ip');
  if (env.TURNSTILE_SECRET) {
    if (!valid.token) return bad('turnstileToken');
    if (!(await turnstileOk(env.TURNSTILE_SECRET, valid.token, ip, deps.fetch ?? ((input, init) => fetch(input, init))))) return bad('turnstileToken');
  }

  // no cf-connecting-ip only happens off Cloudflare (local dev): one shared bucket
  const hash = await ipHash(env.IP_SALT, ip || 'unknown');
  const result = await deps.store(env).insertLimited({ ...valid.report, ipHash: hash }, REPORTS_PER_HOUR);
  if (!result.ok) return json({ error: 'rate limited' }, 429, { 'retry-after': String(result.retryAfter) });
  return json({ ok: true }, 201);
}
