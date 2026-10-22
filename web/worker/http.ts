import type { Env } from './env.js';

/** A JSON response; not cached unless a header says otherwise. */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/** True when the request's Origin header is this site: the request's own origin or SITE_ORIGIN's. */
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

/** The body as text, or null when it is longer than maxBytes (read in chunks, never buffered past the cap). */
async function readCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
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

/**
 * The checks every browser write shares (Ruling R45), in order: same Origin (403), content-type
 * application/json (415), body at most maxBytes (413), valid JSON (400 { error: 'body' }).
 * Gives the parsed body, or the response to send.
 */
export async function readJsonWrite(req: Request, env: Env, url: URL, maxBytes: number): Promise<{ body: unknown } | { response: Response }> {
  if (!originAllowed(req, env, url)) return { response: json({ error: 'forbidden' }, 403) };
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return { response: json({ error: 'content-type' }, 415) };
  const text = await readCapped(req, maxBytes);
  if (text === null) return { response: json({ error: 'too large' }, 413) };
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return { response: json({ error: 'body' }, 400) };
  }
}
