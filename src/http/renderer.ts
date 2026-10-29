// The headless page renderer for shops with config.render = "browser" (owner decision 29 Oct 2026: Crawl4AI).
// One long-lived Python process (tools/renderer/render.py, Crawl4AI in tools/renderer/.venv) renders one page at a
// time and hands back its HTML. It is never called directly by an adapter: ShopFetcher calls it in place of a plain
// GET for HTML pages, after its own robots.txt check, gap, Crawl-delay and request count, so every project rule
// still applies (fetcher.ts). The renderer filters the browser's own requests (no images, no private addresses,
// navigation only on the shop's hosts) and never uses stealth or anti-bot features.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

export interface RenderedPage {
  /** the page's status; 0 when the browser got no answer */
  status: number;
  /** where the browser ended up after redirects */
  url: string;
  html: string;
  /** page and data requests the browser sent to the shop (the page itself, then each Load more answer); 1 if unknown */
  requests?: number;
  /** Load more clicks made */
  clicks?: number;
}

/** Click a "Load more" button: at most maxClicks times, a random gap in gapMs before each, until it adds no items. */
export type LoadMore = { button: string; items: string; maxClicks: number; gapMs: [number, number] };
export type RenderOptions = { allowedHosts: string[]; waitFor?: string; timeoutMs: number; loadMore?: LoadMore };

export interface PageRenderer {
  render(url: string, opts: RenderOptions): Promise<RenderedPage>;
  close(): Promise<void>;
}

/** The renderer failed before the page answered (the browser, the process, or a refused address). */
export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

const ROOT = path.resolve('tools/renderer');
/** Waiting for Chromium to start, on top of the page timeout of the first render. */
const START_MS = 60_000;
/** Extra time the process gets beyond the page timeout before it is killed and restarted. */
const GRACE_MS = 30_000;
/** How long render.py waits for one Load more click to add items (LOAD_MORE_WAIT_S). */
const LOAD_MORE_WAIT_MS = 30_000;

export function rendererPython(): string {
  const env = process.env.RENDERER_PYTHON?.trim();
  if (env) return env;
  return process.platform === 'win32' ? path.join(ROOT, '.venv', 'Scripts', 'python.exe') : path.join(ROOT, '.venv', 'bin', 'python');
}

type Pending = { resolve: (p: RenderedPage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Answer = { id?: number; ready?: boolean; ok?: boolean; status?: number | null; url?: string; html?: string; error?: string; requests?: number; clicks?: number };

/** The Crawl4AI process, started on first use and restarted after a crash or a hung page. */
export class Crawl4aiRenderer implements PageRenderer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(
    private readonly userAgent: string,
    private readonly python = rendererPython(),
    private readonly script = path.join(ROOT, 'render.py'),
    private readonly log: (m: string) => void = () => {},
  ) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    if (!existsSync(this.python)) {
      return Promise.reject(new RenderError(`the page renderer is not installed (${this.python}); see tools/renderer/README.md`));
    }
    const child = spawn(this.python, [this.script], {
      env: { ...process.env, MTP_USER_AGENT: this.userAgent, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    // an idle renderer never keeps a finished run alive; a pending render has its own timer that does
    child.unref();
    for (const s of [child.stdin, child.stdout, child.stderr] as unknown as { unref?: () => void }[]) s.unref?.();
    createInterface({ input: child.stderr }).on('line', (l) => this.log(`[renderer] ${l.slice(0, 300)}`));

    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RenderError('the page renderer did not start in time')), START_MS);
      createInterface({ input: child.stdout }).on('line', (line) => {
        let a: Answer;
        try {
          a = JSON.parse(line) as Answer;
        } catch {
          return;
        }
        if (a.ready) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const p = a.id === undefined ? undefined : this.pending.get(a.id);
        if (!p) return;
        this.pending.delete(a.id!);
        clearTimeout(p.timer);
        if (a.ok && typeof a.html === 'string') {
          p.resolve({ status: Number(a.status ?? 200), url: String(a.url ?? ''), html: a.html, requests: Number(a.requests ?? 1), clicks: Number(a.clicks ?? 0) });
        }
        else if (typeof a.status === 'number' && a.status > 0) p.resolve({ status: a.status, url: '', html: '' });
        else p.reject(new RenderError(a.error ?? 'render failed'));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new RenderError(`the page renderer stopped (exit ${code})`));
        this.reset(new RenderError(`the page renderer stopped (exit ${code})`));
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new RenderError(`the page renderer could not start: ${e.message}`));
        this.reset(new RenderError(e.message));
      });
    });
    // a failed start is tried again on the next render
    this.ready.catch(() => this.reset(new RenderError('the page renderer could not start')));
    return this.ready;
  }

  private reset(e: Error) {
    const child = this.child;
    this.child = null;
    this.ready = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
    if (child && child.exitCode === null) child.kill();
  }

  /** One page at a time across every shop of the run: the process renders in order, so the next waits its turn. */
  render(url: string, opts: RenderOptions): Promise<RenderedPage> {
    const run = this.queue.then(() => this.renderNow(url, opts));
    this.queue = run.catch(() => {});
    return run;
  }

  private queue: Promise<unknown> = Promise.resolve();

  private async renderNow(url: string, opts: RenderOptions): Promise<RenderedPage> {
    // keeps the run alive while Chromium starts
    const hold = setTimeout(() => {}, START_MS);
    try {
      await this.start();
    } finally {
      clearTimeout(hold);
    }
    const id = this.nextId++;
    const lm = opts.loadMore;
    const limit = opts.timeoutMs + GRACE_MS + (lm ? lm.maxClicks * (lm.gapMs[1] + LOAD_MORE_WAIT_MS) : 0);
    return new Promise<RenderedPage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.log(`[renderer] ${url} took longer than ${Math.round(limit / 1000)} s, restarting it`);
        this.reset(new RenderError(`render timed out for ${url}`));
      }, limit);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(
        `${JSON.stringify({ id, url, allowedHosts: opts.allowedHosts, userAgent: this.userAgent, waitFor: opts.waitFor ?? null, timeoutMs: opts.timeoutMs, loadMore: lm ?? null })}\n`,
      );
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.ready = null;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

let shared: Crawl4aiRenderer | null = null;

/** One renderer per process, shared by every browser shop of a run (they still render one page at a time each). */
export function sharedRenderer(userAgent: string, log?: (m: string) => void): PageRenderer {
  shared ??= new Crawl4aiRenderer(userAgent, undefined, undefined, log);
  return shared;
}
