// Runs one batch through the local Claude Code CLI in print mode, on the owner's own login (never --bare, never an
// API key). Shop text is untrusted: tools off, no MCP servers, no user/project settings (so no hooks or plugins),
// no slash commands or skills, no session saved, and the child runs in an empty temp folder.
import { spawn } from 'node:child_process';

export type ClaudeOptions = {
  model: string;
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

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** The CLI arguments. The batch goes on stdin, so there is no prompt argument. */
export function claudeArgs(o: ClaudeOptions): string[] {
  return [
    '-p',
    '--model', o.model,
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
 * Not passed on to the child:
 * - ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL (would move billing to an API key or another endpoint);
 * - CLAUDE_CODE_SIMPLE (what --bare sets) and every other CLAUDE_CODE_* / CLAUDE_AGENT_SDK_* / CLAUDECODE variable a
 *   surrounding Claude Code session sets (host session, provider switches such as CLAUDE_CODE_USE_BEDROCK);
 * - the project's own secrets from .env (database URLs, passwords, keys, salts).
 * Kept: CLAUDE_CODE_OAUTH_TOKEN (the owner's own login, from `claude setup-token`), CLAUDE_CODE_GIT_BASH_PATH and
 * CLAUDE_CONFIG_DIR.
 */
const DROP_ENV =
  /^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$|^CLAUDECODE$|^CLAUDE_CODE_|^CLAUDE_AGENT_SDK_|^CLAUDE_PID$|^CLAUDE_EFFORT$|^CLAUDE_PREVIEW_|DATABASE_URL$|PASSWORD|SECRET|_API_KEY$|_ACCESS_KEY|^IP_SALT$/i;
const KEEP_ENV = /^CLAUDE_CODE_(OAUTH_TOKEN|GIT_BASH_PATH)$/i;

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (KEEP_ENV.test(k) || !DROP_ENV.test(k))) out[k] = v;
  }
  return out;
}

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type Runner = (
  bin: string,
  args: string[],
  o: { input: string; env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
) => Promise<RunResult>;

/** Spawns the CLI. On Windows it gets its own process group, so Ctrl+C in the console lets running batches finish. */
export const spawnRunner: Runner = (bin, args, o) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform === 'win32',
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + extra, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, o.timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => finish(null, e.message));
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
  const usage: Usage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
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

/** One batch: up to two attempts (one retry on a failed, timed out or unparsable answer). Usage adds up over attempts. */
export async function callClaude(
  opts: ClaudeOptions,
  input: string,
  runner: Runner = spawnRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CallResult> {
  const bin = opts.bin ?? env.CLAUDE_BIN ?? 'claude';
  const args = claudeArgs(opts);
  const childEnvVars = childEnv(env);
  let usage = NO_USAGE;
  let costUsd = 0;
  let error = '';
  let raw = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
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
  return { ok: false, error, usage, costUsd, attempts: 2, raw };
}
