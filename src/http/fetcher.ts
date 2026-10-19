import { parseRobots, type RobotsRules } from './robots.js';
import type { ShopConfig } from '../types.js';

export class DisallowedError extends Error {
  constructor(public url: string) {
    super(`robots.txt disallows ${url}`);
  }
}

export class ShopAbortError extends Error {}

export class HttpError extends Error {
  constructor(public url: string, public status: number) {
    super(`HTTP ${status} for ${url}`);
  }
}

export interface FetchResult {
  url: string;
  status: number;
  headers: Headers;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

export interface FetcherOptions {
  userAgent: string;
  minDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxConsecutiveFailures?: number;
  extraDisallow?: RegExp[];
  /** only these hosts (and their subdomains) may be fetched; undefined means any public host */
  allowedHosts?: string[];
  maxBodyBytes?: number;
  log?: (msg: string) => void;
}

/** Shop host without a leading www., so www and apex variants are both in scope. */
export function scopeHost(baseUrl: string): string {
  return new URL(baseUrl).hostname.replace(/^www\./, '');
}

const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[::1\]|\[f[cd][0-9a-f]{2}:|\[fe80:)/i;

export class OutOfScopeError extends Error {
  constructor(public url: string) {
    super(`refusing to fetch out-of-scope URL ${url}`);
  }
}

function compilePatterns(list: unknown, log: (m: string) => void): RegExp[] {
  if (!Array.isArray(list)) return [];
  const out: RegExp[] = [];
  for (const s of list) {
    try {
      out.push(new RegExp(String(s)));
    } catch {
      log(`ignoring invalid extra_disallow pattern ${String(s)}`);
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * Polite HTTP client for one shop: one request at a time, a random 2 to 5 s gap
 * (or the shop's configured gap, or robots Crawl-delay, whichever is longest),
 * robots.txt checked for every URL, backoff on 429 and 5xx, and a failure budget.
 */
export class ShopFetcher {
  readonly ua: string;
  private minDelay: number;
  private maxDelay: number;
  private timeoutMs: number;
  private maxRetries: number;
  private maxConsecutiveFailures: number;
  private extraDisallow: RegExp[];
  private allowedHosts?: string[];
  private maxBodyBytes: number;
  private log: (msg: string) => void;
  private robots = new Map<string, Promise<RobotsRules>>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestEnd = new Map<string, number>();
  private consecutiveFailures = 0;
  private aborted = false;

  stats = { requests: 0, failed: 0, retries: 0, disallowed: 0 };
  disallowedUrls: string[] = [];

  constructor(opts: FetcherOptions) {
    this.ua = opts.userAgent;
    this.minDelay = opts.minDelayMs ?? 2000;
    this.maxDelay = Math.max(opts.maxDelayMs ?? 5000, this.minDelay);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 6;
    this.extraDisallow = opts.extraDisallow ?? [];
    this.allowedHosts = opts.allowedHosts?.map((h) => h.toLowerCase());
    this.maxBodyBytes = opts.maxBodyBytes ?? 30 * 1024 * 1024;
    this.log = opts.log ?? (() => {});
  }

  static fromConfig(cfg: ShopConfig, userAgent: string, baseUrl: string, log?: (m: string) => void): ShopFetcher {
    const extraHosts = Array.isArray(cfg.extra_hosts) ? (cfg.extra_hosts as string[]) : [];
    return new ShopFetcher({
      allowedHosts: [scopeHost(baseUrl), ...extraHosts],
      userAgent,
      minDelayMs: cfg.min_delay_ms,
      maxDelayMs: cfg.max_delay_ms,
      timeoutMs: cfg.timeout_ms,
      maxConsecutiveFailures: cfg.max_consecutive_failures,
      extraDisallow: compilePatterns(cfg.extra_disallow, log ?? (() => {})),
      log,
    });
  }

  get isAborted() {
    return this.aborted;
  }

  /** http(s) only, public hosts only, and (for shop fetchers) only the shop's own hosts. */
  inScope(url: string): boolean {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    if (PRIVATE_HOST.test(host)) return false;
    if (!this.allowedHosts) return true;
    return this.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  }

  /** robots.txt for the origin of url, fetched once per fetcher (i.e. once per run). */
  robotsFor(url: string): Promise<RobotsRules> {
    const origin = new URL(url).origin;
    let p = this.robots.get(origin);
    if (!p) {
      p = this.loadRobots(origin);
      this.robots.set(origin, p);
    }
    return p;
  }

  private async loadRobots(origin: string): Promise<RobotsRules> {
    const robotsUrl = `${origin}/robots.txt`;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.waitTurn(origin, 0);
        this.stats.requests++;
        const res = await fetch(robotsUrl, {
          headers: { 'user-agent': this.ua, accept: 'text/plain,*/*' },
          signal: AbortSignal.timeout(Math.min(this.timeoutMs, 60_000)),
          redirect: 'follow',
        });
        const text = await res.text();
        this.lastRequestEnd.set(origin, Date.now());
        if (res.ok) {
          const rules = parseRobots(origin, text, this.ua, 'ok');
          this.log(`robots.txt ${origin}: ok, crawl-delay ${rules.crawlDelayMs / 1000}s`);
          return rules;
        }
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.log(`robots.txt ${origin}: HTTP ${res.status}, treating as allow all`);
          return parseRobots(origin, '', this.ua, 'none');
        }
        this.log(`robots.txt ${origin}: HTTP ${res.status}, retrying`);
      } catch (e) {
        this.lastRequestEnd.set(origin, Date.now());
        this.log(`robots.txt ${origin}: ${(e as Error).message}, retrying`);
      }
      await sleep(10_000 * 2 ** attempt);
    }
    // RFC 9309: if robots.txt is unreachable because of server errors, assume full disallow.
    this.log(`robots.txt ${origin}: unreachable, treating as disallow all`);
    this.stats.failed++;
    return parseRobots(origin, '', this.ua, 'unreachable');
  }

  async isAllowed(url: string): Promise<boolean> {
    if (this.extraDisallow.some((re) => re.test(url))) return false;
    const rules = await this.robotsFor(url);
    return rules.isAllowed(url);
  }

  private async waitTurn(origin: string, crawlDelayMs: number) {
    const last = this.lastRequestEnd.get(origin);
    if (last === undefined) return;
    const gap = Math.max(crawlDelayMs, this.minDelay + Math.random() * (this.maxDelay - this.minDelay));
    const wait = last + gap - Date.now();
    if (wait > 0) await sleep(wait);
  }

  /** GET a URL. Serialised per fetcher: never two requests to a shop at once. */
  get(url: string, opts: { accept?: string; timeoutMs?: number; allowStatus?: number[]; retries?: number } = {}): Promise<FetchResult> {
    const run = this.queue.then(() => this.doGet(url, opts));
    this.queue = run.catch(() => {});
    return run;
  }

  private async doGet(
    startUrl: string,
    opts: { accept?: string; timeoutMs?: number; allowStatus?: number[]; retries?: number },
  ): Promise<FetchResult> {
    if (this.aborted) throw new ShopAbortError('shop run already abandoned after repeated failures');
    let url = startUrl;
    if (!this.inScope(url)) throw new OutOfScopeError(url);
    if (!(await this.isAllowed(url))) {
      this.stats.disallowed++;
      if (this.disallowedUrls.length < 50) this.disallowedUrls.push(url);
      this.log(`skip (robots.txt): ${url}`);
      throw new DisallowedError(url);
    }
    const origin = new URL(url).origin;
    const rules = await this.robotsFor(url);
    const allow = new Set([200, 404, 410, ...(opts.allowStatus ?? [])]);

    for (let attempt = 0; ; attempt++) {
      await this.waitTurn(origin, rules.crawlDelayMs);
      this.stats.requests++;
      let status = 0;
      let retryAfterMs = 0;
      let errMsg = '';
      try {
        const res = await this.fetchFollowingRedirects(url, opts);
        status = res.status;
        if (allow.has(status) || (status >= 200 && status < 300)) {
          this.lastRequestEnd.set(origin, Date.now());
          this.consecutiveFailures = 0;
          return res;
        }
        const ra = res.headers.get('retry-after');
        if (ra) {
          const secs = Number(ra);
          retryAfterMs = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(ra) - Date.now());
        }
        errMsg = `HTTP ${status}`;
      } catch (e) {
        if (e instanceof DisallowedError) throw e;
        errMsg = (e as Error).name === 'TimeoutError' ? `timeout after ${opts.timeoutMs ?? this.timeoutMs}ms` : (e as Error).message;
      }
      this.lastRequestEnd.set(origin, Date.now());

      const retryable = status === 0 || RETRYABLE.has(status);
      if (retryable && attempt < (opts.retries ?? this.maxRetries)) {
        this.stats.retries++;
        const backoff = Math.min(Math.max(retryAfterMs, 15_000 * 2 ** attempt), 10 * 60_000);
        this.log(`${errMsg} on ${url}, retry ${attempt + 1}/${opts.retries ?? this.maxRetries} in ${Math.round(backoff / 1000)}s`);
        await sleep(backoff + Math.random() * 2000);
        continue;
      }
      this.stats.failed++;
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.aborted = true;
        throw new ShopAbortError(`giving up on shop after ${this.consecutiveFailures} consecutive failures (last: ${errMsg} on ${url})`);
      }
      throw status ? new HttpError(url, status) : new Error(`${errMsg} for ${url}`);
    }
  }

  private async fetchFollowingRedirects(
    startUrl: string,
    opts: { accept?: string; timeoutMs?: number },
  ): Promise<FetchResult> {
    let url = startUrl;
    const signal = AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs);
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetch(url, {
        headers: {
          'user-agent': this.ua,
          accept: opts.accept ?? 'application/json,text/html;q=0.9,*/*;q=0.8',
          'accept-language': 'en-GB,en;q=0.9',
        },
        redirect: 'manual',
        signal,
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel();
        const next = new URL(res.headers.get('location')!, url).toString();
        if (!this.inScope(next)) throw new OutOfScopeError(next);
        if (!(await this.isAllowed(next))) {
          this.stats.disallowed++;
          throw new DisallowedError(next);
        }
        url = next;
        continue;
      }
      const body = await readCapped(res, this.maxBodyBytes);
      return {
        url,
        status: res.status,
        headers: res.headers,
        body,
        text: () => body.toString('utf8'),
        json: <T>() => parseJsonLenient(body.toString('utf8')) as T,
      };
    }
    throw new Error(`too many redirects from ${startUrl}`);
  }
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) {
    await res.body?.cancel();
    throw new Error(`response too large (${declared} bytes)`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max) throw new Error(`response larger than ${max} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Some shops pad JSON responses with HTML (The Model Shop): drop anything before the first [ or {. */
export function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const i = text.search(/[\[{]/);
    if (i < 0) throw new Error('response contains no JSON');
    // try every [ or { from the first one onwards until one parses (HTML can contain braces too)
    // bounded: try at most 50 candidate start positions
    for (let pos = i, tries = 0; pos >= 0 && pos < text.length && tries < 50; tries++) {
      try {
        return JSON.parse(text.slice(pos));
      } catch {
        const next = text.slice(pos + 1).search(/[\[{]/);
        if (next < 0) break;
        pos = pos + 1 + next;
      }
    }
    throw new Error('could not parse JSON from padded response');
  }
}
