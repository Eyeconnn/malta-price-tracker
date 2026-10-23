// Runs one batch through the local Claude Code CLI in print mode, on the owner's own login (never --bare, never an
// API key). Shop text is untrusted: tools off, no MCP servers, no user/project settings (so no hooks or plugins),
// no slash commands or skills, no session saved, and the child runs in an empty temp folder with an allowlisted env.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/** The levels `claude --help` lists for --effort (v2.1.306). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export type ClaudeOptions = {
  model: string;
  /** passed as --effort when set; otherwise the CLI default */
  effort?: Effort;
  systemPromptFile: string;
  /** a JSON file holding {"mcpServers":{}} */
  mcpConfigFile: string;
  /** the answer's JSON schema, inline */
  jsonSchema: string;
  /** working folder of the child (an empty temp folder) */
  cwd: string;
  timeoutMs: number;
  /** the CLI to run; default CLAUDE_BIN or claude on the PATH */
  bin?: string;
};

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; thinkingTokens: number };
export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
  };
}

/** The CLI arguments. The batch goes on stdin, so there is no prompt argument. */
export function claudeArgs(o: ClaudeOptions): string[] {
  if (o.effort !== undefined && !EFFORT_LEVELS.includes(o.effort)) {
    throw new Error(`effort must be one of ${EFFORT_LEVELS.join(', ')}, got ${String(o.effort)}`);
  }
  return [
    '-p',
    '--model', o.model,
    ...(o.effort !== undefined ? ['--effort', o.effort] : []),
    '--output-format', 'json',
    '--json-schema', o.jsonSchema,
    '--system-prompt-file', o.systemPromptFile,
    // no user, project or local settings: the owner's hooks, plugins and permissions do not load
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', o.mcpConfigFile,
    // every built-in tool off
    '--tools', '',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
}

/**
 * The child's environment is an allowlist: what Windows and Node need to start a program and find the user's
 * profile (where Claude Code keeps the owner's login), locale, proxy settings, and the owner's own login token
 * (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`), git bash path and config folder. Everything else stays out:
 * ANTHROPIC_* (API keys, other endpoints), CLAUDE_CODE_SIMPLE (what --bare sets) and the variables of a surrounding
 * Claude Code session, database URLs, GitHub tokens and every other secret.
 */
const ALLOW_ENV = new RegExp(
  '^(' +
    [
      'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME',
      'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES\\(X86\\)', 'PROGRAMW6432',
      'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES\\(X86\\)', 'COMMONPROGRAMW6432', 'USERNAME', 'USER', 'LOGNAME', 'OS',
      'PROCESSOR_[A-Z_]+', 'NUMBER_OF_PROCESSORS', 'LANG', 'LANGUAGE', 'LC_[A-Z_]+', 'TZ', 'XDG_CONFIG_HOME',
      'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
      'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CONFIG_DIR',
    ].join('|') +
    ')$',
  'i',
);

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && ALLOW_ENV.test(k)) out[k] = v;
  }
  return out;
}

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type Runner = (
  bin: string,
  args: string[],
  o: { input: string; env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
) => Promise<RunResult>;

/** How to kill a process and everything it started: taskkill /T on Windows, the process group elsewhere. */
export function killTreeCommand(pid: number, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } | { group: number } {
  return platform === 'win32' ? { cmd: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] } : { group: -pid };
}

/** Kills a process tree. sync: for process exit handlers, where nothing asynchronous runs. */
export function killTree(pid: number, sync = false): void {
  const how = killTreeCommand(pid);
  try {
    if ('group' in how) process.kill(how.group, 'SIGKILL');
    else if (sync) spawnSync(how.cmd, how.args, { stdio: 'ignore', windowsHide: true });
    else spawn(how.cmd, how.args, { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  } catch {
    // already gone
  }
}

const live = new Set<ChildProcess>();

/** Children still running. */
export function liveChildren(): number {
  return live.size;
}

/** Kills every running child tree (second Ctrl+C, process exit). */
export function killAllChildren(sync = false): void {
  for (const c of live) if (c.pid !== undefined) killTree(c.pid, sync);
}

/** After a kill or an exit, the attempt settles within this time even if the pipes never close. */
const SETTLE_GRACE_MS = 5000;

/**
 * Spawns the CLI in its own process group (on Windows that also keeps the console's Ctrl+C away from it, so running
 * batches can finish). On timeout the whole tree is killed; the result settles at close, or at most
 * SETTLE_GRACE_MS after the kill or the exit, even when a grandchild still holds the pipes.
 */
export const spawnRunner: Runner = (bin, args, o) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true });
    live.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      live.delete(child);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + extra, timedOut });
    };
    const settleSoon = () => {
      grace ??= setTimeout(() => finish(exitCode, timedOut ? '' : ' (pipes still open after exit)'), SETTLE_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
      settleSoon();
    }, o.timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => finish(null, e.message));
    child.on('exit', (code) => {
      exitCode = code;
      live.delete(child);
      settleSoon();
    });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(o.input, 'utf8');
  });

export type ParsedResult = { output: unknown; usage: Usage; costUsd: number; durationMs: number | null };

export class ClaudeOutputError extends Error {
  constructor(message: string, readonly usage: Usage, readonly costUsd: number) {
    super(message);
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function jsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  const tries = [t, ...t.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).reverse()];
  for (const s of tries) {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Reads a `claude -p --output-format json` result: the structured answer, token usage and the reported cost. */
export function parseClaudeOutput(stdout: string): ParsedResult {
  const obj = jsonObject(stdout);
  if (!obj) throw new ClaudeOutputError('claude output is not JSON', NO_USAGE, 0);
  const u = (obj.usage ?? {}) as Record<string, unknown>;
  const details = (u.output_tokens_details ?? {}) as Record<string, unknown>;
  const usage: Usage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    thinkingTokens: num(details.thinking_tokens),
  };
  const costUsd = num(obj.total_cost_usd);
  if (obj.is_error === true || (typeof obj.subtype === 'string' && obj.subtype !== 'success')) {
    const why = typeof obj.result === 'string' && obj.result !== '' ? obj.result : String(obj.subtype ?? 'error');
    throw new ClaudeOutputError(`claude reported an error: ${why.slice(0, 500)}`, usage, costUsd);
  }
  let output: unknown = obj.structured_output;
  if (output === undefined && typeof obj.result === 'string') {
    output = jsonObject(obj.result.replace(/^```(?:json)?\s*|\s*```$/g, '')) ?? undefined;
  }
  if (!output || typeof output !== 'object' || !Array.isArray((output as { items?: unknown }).items)) {
    throw new ClaudeOutputError('claude answer has no items list', usage, costUsd);
  }
  return { output, usage, costUsd, durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : null };
}

export type CallResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
  usage: Usage;
  costUsd: number;
  attempts: number;
  /** stdout of the last attempt */
  raw: string;
};

/**
 * One batch: up to two attempts (one retry on a failed, timed out or unparsable answer, unless shouldStop says
 * the run is stopping). Usage adds up over attempts.
 */
export async function callClaude(
  opts: ClaudeOptions,
  input: string,
  runner: Runner = spawnRunner,
  env: NodeJS.ProcessEnv = process.env,
  shouldStop: () => boolean = () => false,
): Promise<CallResult> {
  const bin = opts.bin ?? env.CLAUDE_BIN ?? 'claude';
  const args = claudeArgs(opts);
  const childEnvVars = childEnv(env);
  let usage = NO_USAGE;
  let costUsd = 0;
  let error = '';
  let raw = '';
  let attempt = 0;
  while (attempt < 2) {
    if (attempt > 0 && shouldStop()) break;
    attempt++;
    const r = await runner(bin, args, { input, env: childEnvVars, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    raw = r.stdout;
    if (r.timedOut) {
      error = `claude timed out after ${Math.round(opts.timeoutMs / 1000)}s`;
      continue;
    }
    if (r.stdout.trim() === '') {
      error = `claude exited with code ${r.code} and no output: ${r.stderr.trim().slice(0, 500)}`;
      continue;
    }
    try {
      const p = parseClaudeOutput(r.stdout);
      usage = addUsage(usage, p.usage);
      costUsd += p.costUsd;
      if (r.code === 0) return { ok: true, output: p.output, usage, costUsd, attempts: attempt, raw };
      error = `claude exited with code ${r.code}: ${r.stderr.trim().slice(0, 500)}`;
    } catch (e) {
      if (e instanceof ClaudeOutputError) {
        usage = addUsage(usage, e.usage);
        costUsd += e.costUsd;
      }
      error = `${(e as Error).message}${r.stderr.trim() ? ` (${r.stderr.trim().slice(0, 300)})` : ''}`;
    }
  }
  return { ok: false, error, usage, costUsd, attempts: attempt, raw };
}
