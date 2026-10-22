import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { callClaude, childEnv, claudeArgs, EFFORT_LEVELS, parseClaudeOutput, type Runner } from '../../src/names/claude.js';

const opts = {
  model: 'haiku',
  systemPromptFile: 'C:/tmp/system.txt',
  mcpConfigFile: 'C:/tmp/mcp.json',
  jsonSchema: '{"type":"object"}',
  cwd: 'C:/tmp',
  timeoutMs: 1000,
};

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}

describe('claudeArgs', () => {
  const args = claudeArgs(opts);

  it('runs print mode with the model, JSON output and the JSON schema', () => {
    expect(args).toContain('-p');
    expect(valueAfter(args, '--model')).toBe('haiku');
    expect(valueAfter(args, '--output-format')).toBe('json');
    expect(valueAfter(args, '--json-schema')).toBe('{"type":"object"}');
    expect(valueAfter(args, '--system-prompt-file')).toBe('C:/tmp/system.txt');
  });

  it('switches tools off, loads no MCP servers, no user settings and saves no session', () => {
    expect(valueAfter(args, '--tools')).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(valueAfter(args, '--mcp-config')).toBe('C:/tmp/mcp.json');
    expect(valueAfter(args, '--setting-sources')).toBe('');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--disable-slash-commands');
  });

  it('passes no --effort by default (CLI default) and passes it through when given', () => {
    expect(args).not.toContain('--effort');
    const withEffort = claudeArgs({ ...opts, effort: 'low' });
    expect(valueAfter(withEffort, '--effort')).toBe('low');
  });

  it('accepts only the effort levels the CLI lists', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(() => claudeArgs({ ...opts, effort: 'turbo' as never })).toThrow(/effort/);
  });

  it('never uses --bare and passes no prompt argument (the batch goes on stdin)', () => {
    expect(args).not.toContain('--bare');
    expect(args.filter((a) => !a.startsWith('-')).every((a) => [opts.model, 'json', opts.jsonSchema, opts.systemPromptFile, opts.mcpConfigFile, ''].includes(a))).toBe(true);
  });
});

describe('childEnv', () => {
  it('drops ANTHROPIC_API_KEY and the project secrets, keeps the rest', () => {
    const env = childEnv({
      PATH: 'p', USERPROFILE: 'u', ANTHROPIC_API_KEY: 'k', DATABASE_URL: 'd', DASHBOARD_DATABASE_URL: 'd2',
      R2_SECRET_ACCESS_KEY: 's', ADMIN_PASSWORD: 'a', IP_SALT: 'i', RESEND_API_KEY: 'r',
    });
    expect(env).toEqual({ PATH: 'p', USERPROFILE: 'u' });
  });

  it('drops what would make the child bare, use another endpoint or join a host session', () => {
    const env = childEnv({
      PATH: 'p', CLAUDE_CODE_SIMPLE: '1', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_MESSAGING_TOKEN: 't',
      CLAUDE_CODE_ENTRYPOINT: 'e', CLAUDE_AGENT_SDK_VERSION: 'v', CLAUDE_PID: '1', CLAUDE_EFFORT: 'low',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'a', CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'owner', CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe', CLAUDE_CONFIG_DIR: 'C:/c',
    });
    expect(env).toEqual({ PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: 'owner', CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe', CLAUDE_CONFIG_DIR: 'C:/c' });
  });
});

describe('parseClaudeOutput', () => {
  it('reads a recorded claude -p --output-format json result', async () => {
    const raw = await readFile('test/names/fixtures/claude-result.json', 'utf8');
    const r = parseClaudeOutput(raw);
    const out = r.output as { items: { key: string; display_name: string }[] };
    expect(out.items.length).toBe(3);
    for (const it of out.items) expect(typeof it.display_name).toBe('string');
    expect(r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens).toBeGreaterThan(0);
    expect(r.usage.outputTokens).toBeGreaterThan(0);
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it('throws on an error result, on text that is not JSON and on an answer without items', () => {
    expect(() => parseClaudeOutput('not json')).toThrow();
    expect(() => parseClaudeOutput(JSON.stringify({ type: 'result', is_error: true, result: 'boom' }))).toThrow(/boom/);
    expect(() => parseClaudeOutput(JSON.stringify({ type: 'result', is_error: false, structured_output: { nope: 1 } }))).toThrow(/items/);
  });

  it('falls back to a JSON result text when there is no structured_output', () => {
    const r = parseClaudeOutput(JSON.stringify({ type: 'result', is_error: false, result: '{"items":[]}', usage: {}, total_cost_usd: 0 }));
    expect(r.output).toEqual({ items: [] });
  });
});

const GOOD = JSON.stringify({
  type: 'result', is_error: false, structured_output: { items: [] }, total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
});

describe('callClaude', () => {
  it('sends the batch on stdin, without ANTHROPIC_API_KEY in the child env', async () => {
    const seen: { input: string; env: NodeJS.ProcessEnv; args: string[] }[] = [];
    const runner: Runner = async (_bin, args, o) => {
      seen.push({ input: o.input, env: o.env, args });
      return { code: 0, stdout: GOOD, stderr: '', timedOut: false };
    };
    const r = await callClaude(opts, 'batch text', runner, { ANTHROPIC_API_KEY: 'secret', PATH: 'p' });
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].input).toBe('batch text');
    expect(seen[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen[0].env.PATH).toBe('p');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3 });
    expect(r.costUsd).toBeCloseTo(0.01);
  });

  it('retries once on a failed or unparsable answer and adds up the usage of both attempts', async () => {
    let n = 0;
    const runner: Runner = async () => {
      n++;
      return n === 1 ? { code: 0, stdout: 'garbage', stderr: '', timedOut: false } : { code: 0, stdout: GOOD, stderr: '', timedOut: false };
    };
    const r = await callClaude(opts, 'x', runner, {});
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it('gives up after the retry', async () => {
    let n = 0;
    const runner: Runner = async () => {
      n++;
      return { code: 1, stdout: '', stderr: 'bad flag', timedOut: false };
    };
    const r = await callClaude(opts, 'x', runner, {});
    expect(r.ok).toBe(false);
    expect(n).toBe(2);
    expect(r.error).toContain('bad flag');
  });

  it('reports a timeout', async () => {
    const runner: Runner = async () => ({ code: null, stdout: '', stderr: '', timedOut: true });
    const r = await callClaude(opts, 'x', runner, {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });
});
