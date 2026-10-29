import { safeFetch } from './safeNet.js';
import { existsSync } from 'node:fs';
import { type PageRenderer, rendererPython, sharedRenderer } from './renderer.js';
import { parseRobots, type RobotsRules } from './robots.js';
import type { ShopConfig } from '../types.js';

export class DisallowedError extends Error {
  constructor(public url: string) {
    super(`robots.txt disallows ${url}`);
  }
}

export class ShopAbortError extends Error {}

/** A redirect points outside the fetcher's allowed hosts; url is where it pointed. Not retried. */
export class RedirectOutOfScopeError extends Error {
  constructor(public url: string) {
    super(`refusing to follow a redirect to out-of-scope URL ${url}`);
  }
}

/** More redirects than the fetcher allows (maxRedirects); the next hop is not fetched. Not retried. */
export class TooManyRedirectsError extends Error {}

/** The answer is larger than the fetcher's (or the request's) body limit; not retried. */
export class BodyTooLargeError extends Error {}

export class HttpError extends Error {
  /** retryAfterMs: the answer's Retry-After in ms (null when absent); waitTooLong: it was longer than the backoff cap */
  constructor(
    public url: string,
    public status: number,
    public retryAfterMs: number | null = null,
    waitTooLong = false,
  ) {
    super(`HTTP ${status} for ${url}${waitTooLong && retryAfterMs !== null ? ` (asked to wait ${Math.round(retryAfterMs / 1000)} s)` : ''}`);
  }
}

/** The longest backoff (and the longest Retry-After) a fetcher waits before retrying. */
export const MAX_BACKOFF_MS = 10 * 60_000;
/** robots.txt is read up to this size (RFC 9309 allows stopping at 500 KiB). */
export const ROBOTS_MAX_BYTES = 500 * 1024;

/** Spacing key: the host without www., so www. and the apex of a shop share one request gap. */
export function spacingKey(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

/** Retry-After as milliseconds (seconds or an HTTP date); null when absent or unreadable. */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value.trim());
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export interface FetchResult {
  url: string;
  status: number;
  headers: Headers;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

/** A request cap shared by several fetchers; used counts every request made so far. */
export interface RequestBudget {
  max: number;
  used: number;
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
  /** hard cap on requests (robots.txt and every attempt included); past it the run stops with ShopAbortError */
  maxRequests?: number;
  /**
   * a request cap shared by several fetchers (a shop's own and its image CDN's, for the logo job): every request of
   * each counts against it, and past it the fetcher stops with ShopAbortError as with maxRequests
   */
  budget?: RequestBudget;
  /** redirects followed per request (default 5); past it TooManyRedirectsError. With a budget, every hop is a request */
  maxRedirects?: number;
  /** a hard stop (a deadline): once aborted, waits and requests end at once with ShopAbortError */
  signal?: AbortSignal;
  /**
   * renders HTML page requests (accept text/html) in a headless browser instead of a plain GET (config.render =
   * "browser", renderer.ts). robots.txt, the gap, Crawl-delay, retries and the request count apply as to any request.
   */
  renderer?: PageRenderer;
  /** a CSS selector the renderer waits for before it hands the page back (config.render_wait_for) */
  renderWaitFor?: string;
  /** a "Load more" button the renderer clicks on listing pages, each click a request to the shop (config.render_load_more) */
  renderLoadMore?: { button: string; items: string; max_clicks?: number };
  /** only HTML pages whose address matches are rendered; the rest stay plain HTTP (config.render_urls) */
  renderUrls?: RegExp;
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

/** Load more clicks per listing page unless the shop's config says otherwise. */
const DEFAULT_LOAD_MORE_CLICKS = 20;

/** config.render_load_more, when it names a button and the items it adds. */
function loadMoreConfig(v: unknown): { button: string; items: string; max_clicks?: number } | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.button !== 'string' || typeof o.items !== 'string') return undefined;
  return { button: o.button, items: o.items, max_clicks: typeof o.max_clicks === 'number' && o.max_clicks >= 0 ? Math.floor(o.max_clicks) : undefined };
}
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
/** Statuses the fetcher retries with backoff (timeouts, 429, server errors, Cloudflare 52x). */
export const isRetryableStatus = (status: number): boolean => RETRYABLE.has(status);

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
  private maxRequests?: number;
  private budget?: RequestBudget;
  private maxRedirects: number;
  private signal?: AbortSignal;
  private renderer?: PageRenderer;
  private renderWaitFor?: string;
  private renderLoadMore?: { button: string; items: string; max_clicks?: number };
  private renderUrls?: RegExp;
  private abortReason?: string;
  private log: (msg: string) => void;
  private robots = new Map<string, Promise<RobotsRules>>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestEnd = new Map<string, number>();
  private consecutiveFailures = 0;
  private aborted = false;

  /** rateLimited: requests that finally failed with 429 or 5xx; retryAfterMs: the last such answer's Retry-After */
  stats = { requests: 0, failed: 0, retries: 0, disallowed: 0, rateLimited: 0, retryAfterMs: null as number | null };
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
    this.maxRequests = opts.maxRequests;
    this.budget = opts.budget;
    this.maxRedirects = opts.maxRedirects ?? 5;
    this.signal = opts.signal;
    this.renderer = opts.renderer;
    this.renderWaitFor = opts.renderWaitFor;
    this.renderLoadMore = opts.renderLoadMore;
    this.renderUrls = opts.renderUrls;
    this.log = opts.log ?? (() => {});
  }

  /** extra: options a caller sets for one run only (e.g. the shop-request test scrape's maxRequests) */
  static fromConfig(
    cfg: ShopConfig,
    userAgent: string,
    baseUrl: string,
    log?: (m: string) => void,
    extra: Pick<FetcherOptions, 'maxRequests' | 'budget' | 'maxRetries' | 'minDelayMs' | 'maxDelayMs' | 'maxBodyBytes' | 'maxRedirects' | 'signal'> = {},
  ): ShopFetcher {
    const extraHosts = Array.isArray(cfg.extra_hosts) ? (cfg.extra_hosts as string[]) : [];
    const browser = cfg.render === 'browser';
    // a browser shop on a machine without the renderer (e.g. GitHub) stops at once, not after retrying every page
    if (browser && !existsSync(rendererPython())) throw new Error(`this shop needs the page renderer (config.render = "browser"), which is not installed here; see tools/renderer/README.md`);
    return new ShopFetcher({
      renderer: browser ? sharedRenderer(userAgent, log) : undefined,
      renderWaitFor: browser && typeof cfg.render_wait_for === 'string' ? cfg.render_wait_for : undefined,
      renderLoadMore: browser ? loadMoreConfig(cfg.render_load_more) : undefined,
      renderUrls: browser && typeof cfg.render_urls === 'string' ? new RegExp(cfg.render_urls) : undefined,
      allowedHosts: [scopeHost(baseUrl), ...extraHosts],
      userAgent,
      minDelayMs: cfg.min_delay_ms,
      maxDelayMs: cfg.max_delay_ms,
      timeoutMs: cfg.timeout_ms,
      maxConsecutiveFailures: cfg.max_consecutive_failures,
      extraDisallow: compilePatterns(cfg.extra_disallow, log ?? (() => {})),
      log,
      ...extra,
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
    const key = spacingKey(origin);
    let httpStatus: number | undefined;
    let retryAfterMs: number | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.waitTurn(key, 0);
      // outside the try: reaching the request cap stops the run instead of being retried
      this.spend();
      try {
        const res = await this.fetchRobots(robotsUrl);
        if (!res) {
          this.lastRequestEnd.set(key, Date.now());
          // RFC 9309: robots.txt not reached within the redirects followed counts as unavailable (allow all)
          this.log(`robots.txt ${origin}: too many or unusable redirects, treating as allow all`);
          return parseRobots(origin, '', this.ua, 'none');
        }
        // RFC 9309: crawlers may stop reading after 500 KiB
        const text = await readTruncated(res, ROBOTS_MAX_BYTES);
        this.lastRequestEnd.set(key, Date.now());
        if (res.ok) {
          const rules = parseRobots(origin, text, this.ua, 'ok');
          this.log(`robots.txt ${origin}: ok, crawl-delay ${rules.crawlDelayMs / 1000}s`);
          return rules;
        }
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.log(`robots.txt ${origin}: HTTP ${res.status}, treating as allow all`);
          return parseRobots(origin, '', this.ua, 'none');
        }
        httpStatus = res.status;
        retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        if (retryAfterMs !== null && retryAfterMs > MAX_BACKOFF_MS) {
          this.log(`robots.txt ${origin}: HTTP ${res.status}, asked to wait ${Math.round(retryAfterMs / 1000)} s, not retrying`);
          break;
        }
        this.log(`robots.txt ${origin}: HTTP ${res.status}${attempt < this.maxRetries ? ', retrying' : ''}`);
      } catch (e) {
        this.lastRequestEnd.set(key, Date.now());
        if (e instanceof ShopAbortError) throw e;
        this.checkSignal();
        this.log(`robots.txt ${origin}: ${(e as Error).message}${attempt < this.maxRetries ? ', retrying' : ''}`);
      }
      if (attempt < this.maxRetries) await this.pause(Math.max(retryAfterMs ?? 0, 10_000 * 2 ** attempt));
    }
    // RFC 9309: if robots.txt is unreachable because of server errors, assume full disallow.
    this.log(`robots.txt ${origin}: unreachable, treating as disallow all`);
    this.stats.failed++;
    if (httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500)) {
      this.stats.rateLimited++;
      this.stats.retryAfterMs = retryAfterMs;
    }
    return { ...parseRobots(origin, '', this.ua, 'unreachable'), httpStatus, retryAfterMs };
  }

  /**
   * robots.txt, following redirects. Without a budget undici follows them; with one, every hop is a counted request
   * after the gap, at most maxRedirects hops to public http(s) addresses. null: not reached within those.
   */
  private async fetchRobots(robotsUrl: string): Promise<Awaited<ReturnType<typeof safeFetch>> | null> {
    const init = (redirect: 'follow' | 'manual') => ({
      headers: { 'user-agent': this.ua, accept: 'text/plain,*/*' },
      signal: this.requestSignal(Math.min(this.timeoutMs, 60_000)),
      redirect,
    });
    if (!this.budget) return safeFetch(robotsUrl, init('follow'));
    let url = robotsUrl;
    for (let hop = 0; ; hop++) {
      const res = await safeFetch(url, init('manual'));
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) return res;
      await res.body?.cancel();
      this.lastRequestEnd.set(spacingKey(url), Date.now());
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return null;
      }
      if (hop >= this.maxRedirects || (next.protocol !== 'https:' && next.protocol !== 'http:') || PRIVATE_HOST.test(next.hostname)) return null;
      await this.waitTurn(spacingKey(next.href), 0);
      this.spend();
      url = next.href;
    }
  }

  /** Throws ShopAbortError once the fetcher's signal (its deadline) has fired. */
  private checkSignal() {
    if (this.signal?.aborted) {
      this.aborted = true;
      this.abortReason = 'deadline reached';
      throw new ShopAbortError(this.abortReason);
    }
  }

  /** A request's own timeout, ended early by the fetcher's signal. */
  private requestSignal(timeoutMs: number): AbortSignal {
    const t = AbortSignal.timeout(timeoutMs);
    return this.signal ? AbortSignal.any([t, this.signal]) : t;
  }

  /** sleep that ends with ShopAbortError when the fetcher's signal fires */
  private pause(ms: number): Promise<void> {
    this.checkSignal();
    const signal = this.signal;
    if (!signal) return sleep(ms) as Promise<void>;
    return new Promise<void>((resolve, reject) => {
      const stop = () => {
        clearTimeout(t);
        try {
          this.checkSignal();
        } catch (e) {
          reject(e);
        }
      };
      const t = setTimeout(() => {
        signal.removeEventListener('abort', stop);
        resolve();
      }, ms);
      signal.addEventListener('abort', stop, { once: true });
    });
  }

  async isAllowed(url: string): Promise<boolean> {
    if (this.extraDisallow.some((re) => re.test(url))) return false;
    const rules = await this.robotsFor(url);
    return rules.isAllowed(url);
  }

  /** Counts one request; past maxRequests the run is abandoned (ShopAbortError). */
  private spend() {
    if (this.maxRequests !== undefined && this.stats.requests >= this.maxRequests) {
      this.aborted = true;
      this.abortReason = `request cap of ${this.maxRequests} reached`;
      throw new ShopAbortError(this.abortReason);
    }
    if (this.budget && this.budget.used >= this.budget.max) {
      this.aborted = true;
      this.abortReason = `request cap of ${this.budget.max} reached`;
      throw new ShopAbortError(this.abortReason);
    }
    if (this.budget) this.budget.used++;
    this.stats.requests++;
  }

  /** key: the shop host without www. (spacingKey), so www. and the apex share one gap */
  private async waitTurn(key: string, crawlDelayMs: number) {
    const last = this.lastRequestEnd.get(key);
    if (last === undefined) return;
    const gap = Math.max(crawlDelayMs, this.minDelay + Math.random() * (this.maxDelay - this.minDelay));
    const wait = last + gap - Date.now();
    if (wait > 0) await this.pause(wait);
  }

  /** GET a URL. Serialised per fetcher: never two requests to a shop at once. */
  /** maxBodyBytes: a lower body limit for this request (image downloads); a larger answer fails without a retry */
  get(url: string, opts: { accept?: string; timeoutMs?: number; allowStatus?: number[]; retries?: number; maxBodyBytes?: number; maxRedirects?: number } = {}): Promise<FetchResult> {
    const run = this.queue.then(() => this.doGet(url, opts));
    this.queue = run.catch(() => {});
    return run;
  }

  private async doGet(
    startUrl: string,
    opts: { accept?: string; timeoutMs?: number; allowStatus?: number[]; retries?: number; maxBodyBytes?: number; maxRedirects?: number },
  ): Promise<FetchResult> {
    if (this.aborted) throw new ShopAbortError(this.abortReason ?? 'shop run already abandoned after repeated failures');
    this.checkSignal();
    let url = startUrl;
    if (!this.inScope(url)) throw new OutOfScopeError(url);
    if (!(await this.isAllowed(url))) {
      this.stats.disallowed++;
      if (this.disallowedUrls.length < 50) this.disallowedUrls.push(url);
      this.log(`skip (robots.txt): ${url}`);
      throw new DisallowedError(url);
    }
    const key = spacingKey(url);
    const rules = await this.robotsFor(url);
    // 202 is deliberately not success: some shops answer bot challenges with 202 and an HTML page
    const allow = new Set([200, 203, 204, 206, 404, 410, ...(opts.allowStatus ?? [])]);

    for (let attempt = 0; ; attempt++) {
      await this.waitTurn(key, rules.crawlDelayMs);
      this.spend();
      let status = 0;
      let retryAfterMs: number | null = null;
      let errMsg = '';
      let tooLarge = false;
      try {
        const res = this.shouldRender(url, opts.accept) ? await this.renderPage(url, opts) : await this.fetchFollowingRedirects(url, opts);
        status = res.status;
        if (allow.has(status)) {
          this.lastRequestEnd.set(key, Date.now());
          this.consecutiveFailures = 0;
          return res;
        }
        retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        errMsg = `HTTP ${status}`;
      } catch (e) {
        if (e instanceof DisallowedError || e instanceof RedirectOutOfScopeError || e instanceof TooManyRedirectsError || e instanceof ShopAbortError) throw e;
        this.checkSignal();
        // fetching a too large answer again would only download it again
        tooLarge = e instanceof BodyTooLargeError;
        errMsg = (e as Error).name === 'TimeoutError' ? `timeout after ${opts.timeoutMs ?? this.timeoutMs}ms` : (e as Error).message;
      }
      this.lastRequestEnd.set(key, Date.now());

      // a Retry-After longer than the backoff cap is not waited for: the request fails now
      const waitTooLong = retryAfterMs !== null && retryAfterMs > MAX_BACKOFF_MS;
      if (waitTooLong) errMsg = `${errMsg} (asked to wait ${Math.round(retryAfterMs! / 1000)} s)`;
      const retryable = (status === 0 || RETRYABLE.has(status)) && !waitTooLong && !tooLarge;
      if (retryable && attempt < (opts.retries ?? this.maxRetries)) {
        this.stats.retries++;
        const backoff = Math.min(Math.max(retryAfterMs ?? 0, 15_000 * 2 ** attempt), MAX_BACKOFF_MS);
        this.log(`${errMsg} on ${url}, retry ${attempt + 1}/${opts.retries ?? this.maxRetries} in ${Math.round(backoff / 1000)}s`);
        await this.pause(backoff + Math.random() * 2000);
        continue;
      }
      this.stats.failed++;
      if (status === 429 || status >= 500) {
        this.stats.rateLimited++;
        this.stats.retryAfterMs = retryAfterMs;
      }
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.aborted = true;
        throw new ShopAbortError(`giving up on shop after ${this.consecutiveFailures} consecutive failures (last: ${errMsg} on ${url})`);
      }
      throw status ? new HttpError(url, status, retryAfterMs, waitTooLong) : new Error(`${errMsg} for ${url}`);
    }
  }

  /**
   * An HTML page through the headless renderer. The browser follows redirects itself, only within the shop's hosts
   * (the renderer refuses any other navigation); the page it ends on must be in scope and allowed by robots.txt,
   * or its content is dropped.
   */
  private async renderPage(url: string, opts: { timeoutMs?: number }): Promise<FetchResult> {
    const page = await this.renderer!.render(url, {
      allowedHosts: this.allowedHosts ?? [scopeHost(url)],
      waitFor: this.renderWaitFor,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      loadMore: await this.loadMoreFor(url),
    });
    // the page itself was counted before it was sent; each Load more answer is a request to the shop too
    this.countExtra(Math.max(0, (page.requests ?? 1) - 1));
    if (page.clicks) this.log(`${url}: Load more clicked ${page.clicks} times (${page.requests ?? 1} requests)`);
    const final = page.url || url;
    if (final !== url) {
      if (!this.inScope(final)) throw new RedirectOutOfScopeError(final);
      if (!(await this.isAllowed(final))) {
        this.stats.disallowed++;
        throw new DisallowedError(final);
      }
    }
    const body = Buffer.from(page.html, 'utf8');
    return {
      url: final,
      status: page.status,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body,
      text: () => body.toString('utf8'),
      json: <T>() => parseJsonLenient(body.toString('utf8')) as T,
    };
  }

  /** HTML page requests of a browser shop, limited to render_urls when the shop gives it. */
  private shouldRender(url: string, accept: string | undefined): boolean {
    if (!this.renderer || !accept?.startsWith('text/html')) return false;
    return !this.renderUrls || this.renderUrls.test(url);
  }

  /**
   * Load more for this page: the gap before each click is the fetcher's own (2 to 5 s, or a longer Crawl-delay),
   * and the clicks never take the run past its request cap.
   */
  private async loadMoreFor(url: string) {
    const lm = this.renderLoadMore;
    if (!lm) return undefined;
    const crawlDelay = (await this.robotsFor(url)).crawlDelayMs;
    const left = Math.min(
      this.maxRequests === undefined ? Infinity : this.maxRequests - this.stats.requests,
      this.budget ? this.budget.max - this.budget.used : Infinity,
    );
    const maxClicks = Math.max(0, Math.min(lm.max_clicks ?? DEFAULT_LOAD_MORE_CLICKS, left));
    if (maxClicks === 0) return undefined;
    return { button: lm.button, items: lm.items, maxClicks, gapMs: [Math.max(crawlDelay, this.minDelay), Math.max(crawlDelay, this.maxDelay)] as [number, number] };
  }

  /** Requests the browser made beyond the counted page (Load more answers); counted, never over the caps by design. */
  private countExtra(n: number) {
    if (n <= 0) return;
    this.stats.requests += n;
    if (this.budget) this.budget.used += n;
  }

  private async fetchFollowingRedirects(
    startUrl: string,
    opts: { accept?: string; timeoutMs?: number; maxBodyBytes?: number; maxRedirects?: number },
  ): Promise<FetchResult> {
    let url = startUrl;
    // a request may allow fewer redirects than the fetcher, never more
    const maxRedirects = Math.min(opts.maxRedirects ?? this.maxRedirects, this.maxRedirects);
    const signal = this.requestSignal(opts.timeoutMs ?? this.timeoutMs);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (hop > 0 && this.budget) {
        // with a budget every hop is a request of its own: after the gap (and Crawl-delay) and counted
        await this.waitTurn(spacingKey(url), (await this.robotsFor(url)).crawlDelayMs);
        this.spend();
      }
      const res = await safeFetch(url, {
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
        if (this.budget) this.lastRequestEnd.set(spacingKey(url), Date.now());
        const next = new URL(res.headers.get('location')!, url).toString();
        if (!this.inScope(next)) throw new RedirectOutOfScopeError(next);
        if (hop >= maxRedirects) throw new TooManyRedirectsError(`too many redirects from ${startUrl} (at most ${maxRedirects})`);
        if (!(await this.isAllowed(next))) {
          this.stats.disallowed++;
          throw new DisallowedError(next);
        }
        url = next;
        continue;
      }
      const body = await readCapped(res, Math.min(opts.maxBodyBytes ?? this.maxBodyBytes, this.maxBodyBytes));
      return {
        url,
        status: res.status,
        headers: res.headers,
        body,
        text: () => body.toString('utf8'),
        json: <T>() => parseJsonLenient(body.toString('utf8')) as T,
      };
    }
    throw new TooManyRedirectsError(`too many redirects from ${startUrl}`);
  }
}

/** The body as text, at most max bytes (the rest is not read). */
async function readTruncated(res: Awaited<ReturnType<typeof safeFetch>>, max: number): Promise<string> {
  if (!res.body) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    chunks.push(Buffer.from(chunk));
    size += chunk.length;
    if (size >= max) break;
  }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

async function readCapped(res: Awaited<ReturnType<typeof safeFetch>>, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) {
    await res.body?.cancel();
    throw new BodyTooLargeError(`response too large (${declared} bytes)`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    // leaving the loop cancels the stream
    if (size > max) throw new BodyTooLargeError(`response larger than ${max} bytes`);
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
