// pnpm judge-matches --model sonnet [--effort low] [--pilot] [--limit 300] [--seed pilot] [--category phones ...]
//   [--batch-size 15] [--max-listings 120] [--parallel 2] [--max-batches N] [--max-cost 5] [--dry-run] [--timeout 600]
//   [--save-raw]
// Design "Update 23 Oct, afternoon: Claude judges candidate groups side by side". Builds the candidate groups of fresh
// listings (src/match/candidates.ts), skips those whose stored judgement has the current fingerprint, and sends the
// rest to Claude Code (claude -p on the owner's own login, the billing-safe runner of the name normaliser: never
// --bare, allowlisted env, tools off, no MCP servers, no settings, timeouts, process-tree kill) in batches of several
// groups. Claude says which listings are exactly the same product and lists every difference; the veto in code
// (src/match/veto.ts) overrules any "same" the listings' facts contradict. Every run writes a report to out/judge/.
// Reads with DASHBOARD_DATABASE_URL (read-only role; works before migration 013). Without --dry-run, writes
// match_judgements and judge_runs with DATABASE_URL (needs migration 013); such a run needs --pilot or --max-batches.
// A run stops after 5 failed batches in a row, and at once on a login or usage-limit error; --max-cost starts no new
// batch once the summed reported cost reaches it. Ctrl+C stops after the running batches; a second Ctrl+C quits at
// once and kills the running claude processes with everything they started. The report and judge_runs.finished_at
// are written on every stop.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { closeDb, db } from '../db.js';
import { env } from '../env.js';
import { buildCandidates, spreadSample } from '../match/candidates.js';
import { DEFAULT_BATCH_GROUPS, DEFAULT_BATCH_LISTINGS, judgeJsonSchema, judgeMessage, judgeSystemPrompt, makeJudgeBatches, type JudgeBatch } from '../match/judge.js';
import { loadListings } from '../match/load.js';
import { writeJudgeReport, type JudgeBatchStat, type JudgeGroupRow } from '../match/report.js';
import { failedBatch, settleBatch } from '../match/settle.js';
import { finishJudgeRun, hasJudgeTables, loadStoredFingerprints, saveJudgements, startJudgeRun } from '../match/store.js';
import { addUsage, callClaude, killAllChildren, NO_USAGE, spawnRunner, type Usage } from '../names/claude.js';
import { budgetReached, checkRunScope, FailureBreaker, MAX_CONSECUTIVE_FAILURES, parseEffort, parseMaxCost } from '../names/options.js';
import { SITE_CATEGORIES } from '../site/categories.js';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    effort: { type: 'string' },
    pilot: { type: 'boolean', default: false },
    limit: { type: 'string', default: '300' },
    seed: { type: 'string', default: 'pilot' },
    category: { type: 'string', multiple: true },
    'batch-size': { type: 'string', default: String(DEFAULT_BATCH_GROUPS) },
    'max-listings': { type: 'string', default: String(DEFAULT_BATCH_LISTINGS) },
    parallel: { type: 'string', default: '2' },
    'max-batches': { type: 'string' },
    'max-cost': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    timeout: { type: 'string', default: '600' },
    'save-raw': { type: 'boolean', default: false },
  },
});

const OUT_DIR = path.resolve('out/judge');
const MAX_PARALLEL = 6;

function intOption(name: string, raw: string | undefined, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} needs a whole number from ${min} to ${max}, got ${raw}`);
  return n;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

async function main() {
  const model = values.model?.trim();
  if (!model) throw new Error('--model is required (for example haiku, sonnet, opus)');
  if (!/^[A-Za-z0-9._\-[\]]+$/.test(model)) throw new Error(`--model has unexpected characters: ${model}`);
  const effort = parseEffort(values.effort);
  const pilot = values.pilot;
  const dryRun = values['dry-run'];
  const limit = intOption('limit', values.limit, 1, 100000);
  const batchSize = intOption('batch-size', values['batch-size'], 1, 50);
  const maxListings = intOption('max-listings', values['max-listings'], 2, 400);
  const parallel = intOption('parallel', values.parallel, 1, MAX_PARALLEL);
  const maxBatches = values['max-batches'] === undefined ? undefined : intOption('max-batches', values['max-batches'], 1, 100000);
  const maxCost = parseMaxCost(values['max-cost']);
  checkRunScope({ dryRun, pilot, maxBatches });
  const timeoutMs = intOption('timeout', values.timeout, 10, 3600) * 1000;
  const slugs = SITE_CATEGORIES.map((c) => c.slug as string);
  const categories = values.category ?? [];
  for (const c of categories) if (!slugs.includes(c)) throw new Error(`unknown --category ${c} (one of ${slugs.join(', ')})`);

  const rw = dryRun ? null : db();
  if (rw && !(await hasJudgeTables(rw))) throw new Error('a run that writes needs migration 013 (match_judgements, judge_runs); run pnpm migrate first, or use --dry-run');

  const ro = postgres(env('DASHBOARD_DATABASE_URL'), { max: 2, idle_timeout: 20, connect_timeout: 30, onnotice: () => {} });
  let listings;
  let stored: Map<string, string>;
  try {
    listings = await loadListings(ro);
    stored = await loadStoredFingerprints(ro);
  } finally {
    await ro.end({ timeout: 5 });
  }
  const all = buildCandidates(listings).filter((c) => categories.length === 0 || categories.includes(c.category));
  const todo = all.filter((c) => stored.get(c.key) !== c.fingerprint);
  const chosen = pilot ? spreadSample(todo, limit, values.seed) : todo;
  const batches = makeJudgeBatches(chosen, batchSize, maxListings).slice(0, maxBatches ?? Infinity);
  const groupCount = batches.reduce((n, b) => n + b.groups.length, 0);
  const listingCount = batches.reduce((n, b) => n + b.groups.reduce((m, g) => m + g.candidate.members.length, 0), 0);
  console.log(
    `judge-matches: ${listings.length} fresh listings, ${all.length} candidate groups, ${todo.length} new or changed (${stored.size} judgements stored); ` +
      `${groupCount} groups (${listingCount} listings) in ${batches.length} batches, model ${model}, effort ${effort ?? 'CLI default'}` +
      `${maxCost !== undefined ? `, max cost $${maxCost}` : ''}${pilot ? ', pilot' : ''}${dryRun ? ', dry run (no database writes)' : ''}`,
  );
  if (batches.length === 0) return;

  const work = await mkdtemp(path.join(tmpdir(), 'judge-run-'));
  const mcpConfigFile = path.join(work, 'mcp.json');
  await writeFile(mcpConfigFile, JSON.stringify({ mcpServers: {} }), 'utf8');
  const systemPromptFile = path.join(work, 'system.txt');
  await writeFile(systemPromptFile, judgeSystemPrompt(), 'utf8');
  const jsonSchema = JSON.stringify(judgeJsonSchema());
  // the child runs in an empty folder, so no project files (CLAUDE.md, .mcp.json) are near it
  const childCwd = path.join(work, 'cwd');
  await mkdir(childCwd);

  const runId = rw ? String(await startJudgeRun(rw, { model, effort: effort ?? null, pilot })) : `dry-${stamp()}`;
  const rawDir = path.join(OUT_DIR, `${runId}-${model.replace(/[^A-Za-z0-9._-]+/g, '_')}-raw`);
  if (values['save-raw']) await mkdir(rawDir, { recursive: true });

  let stopping = false;
  process.on('exit', () => killAllChildren(true));
  process.on('SIGINT', () => {
    if (stopping) {
      killAllChildren(true);
      process.exit(130);
    }
    stopping = true;
    console.log('judge-matches: stopping after the running batches (Ctrl+C again to quit now)');
  });

  const started = Date.now();
  const rows: JudgeGroupRow[] = [];
  const batchStats: JudgeBatchStat[] = [];
  let usage: Usage = NO_USAGE;
  let costUsd = 0;
  const totals = { groups: 0, judged: 0, rejected: 0, failedGroups: 0, matched: 0, vetoes: 0, failedBatches: 0, done: 0 };
  let next = 0;
  let budgetStop = false;
  const breaker = new FailureBreaker();
  let breakerStop: 'consecutive' | 'auth' | null = null;
  const trip = (ok: boolean, error?: string) => {
    const v = breaker.record(ok, error);
    if (v === 'continue' || breakerStop) return;
    breakerStop = v;
    stopping = true;
    console.log(
      v === 'auth'
        ? `judge-matches: stopping, a login or usage-limit error (${(error ?? '').slice(0, 200)})`
        : `judge-matches: stopping after ${MAX_CONSECUTIVE_FAILURES} failed batches in a row`,
    );
  };
  // report numbers: each batch's groups get the numbers of their order in the plan
  const firstIndex: number[] = [];
  batches.reduce((n, b, i) => ((firstIndex[i] = n), n + b.groups.length), 1);

  async function runBatch(index: number, batch: JudgeBatch) {
    const t0 = Date.now();
    const call = await callClaude(
      { model: model!, effort, systemPromptFile, mcpConfigFile, jsonSchema, cwd: childCwd, timeoutMs },
      judgeMessage(batch),
      spawnRunner,
      process.env,
      () => stopping,
    );
    const listingsIn = batch.groups.reduce((m, g) => m + g.candidate.members.length, 0);
    const stat: JudgeBatchStat = {
      index: index + 1, groups: batch.groups.length, listings: listingsIn, judged: 0, rejected: 0, failed: !call.ok, ...call.usage, costUsd: call.costUsd,
      seconds: (Date.now() - t0) / 1000,
    };
    batchStats.push(stat);
    usage = addUsage(usage, call.usage);
    costUsd += call.costUsd;
    totals.done++;
    totals.groups += batch.groups.length;
    if (values['save-raw']) await writeFile(path.join(rawDir, `batch-${index + 1}.json`), call.raw, 'utf8');
    const tag = `[batch ${index + 1}/${batches.length}] ${batch.groups.length} groups, ${listingsIn} listings`;
    const cost = `${call.usage.inputTokens + call.usage.cacheReadTokens + call.usage.cacheWriteTokens} in, ${call.usage.outputTokens} out, $${call.costUsd.toFixed(4)}, ${stat.seconds.toFixed(1)}s`;
    trip(call.ok, call.error);
    if (!call.ok) {
      totals.failedBatches++;
      totals.failedGroups += batch.groups.length;
      rows.push(...failedBatch(batch, call.error ?? 'batch failed', { batch: index + 1, firstIndex: firstIndex[index] }));
      console.log(`${tag}: FAILED after ${call.attempts} attempts (${call.error}), ${cost}`);
      return;
    }
    const s = settleBatch(batch, call.output, { model: model!, effort: effort ?? null, batch: index + 1, firstIndex: firstIndex[index] });
    rows.push(...s.rows);
    totals.judged += s.judged;
    totals.rejected += s.rejected;
    totals.matched += s.matched;
    totals.vetoes += s.vetoes;
    stat.judged = s.judged;
    stat.rejected = s.rejected;
    let saved = '';
    if (rw) {
      const r = await saveJudgements(rw, Number(runId), s.judgements);
      saved = `, ${r.saved} saved, ${r.superseded} older removed`;
    }
    console.log(`${tag}: ${s.judged} judged, ${s.rejected} rejected, ${s.matched} with a match, ${s.vetoes} vetoed pairs${saved}, ${cost} (${totals.done}/${batches.length} done)`);
  }

  async function worker() {
    while (!stopping && next < batches.length) {
      if (budgetReached(costUsd, maxCost)) {
        if (!budgetStop) console.log(`judge-matches: reported cost $${costUsd.toFixed(4)} reached --max-cost $${maxCost}; no new batches`);
        budgetStop = true;
        break;
      }
      const i = next++;
      try {
        await runBatch(i, batches[i]);
      } catch (e) {
        totals.failedBatches++;
        console.log(`[batch ${i + 1}/${batches.length}] error: ${(e as Error).message}`);
        trip(false, (e as Error).message);
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(parallel, batches.length) }, worker));
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
    await finalize();
  }
  if (breakerStop || (totals.done > 0 && totals.failedBatches === totals.done)) process.exitCode = 1;

  async function finalize() {
    const wallSeconds = (Date.now() - started) / 1000;
    rows.sort((a, b) => a.index - b.index);
    const summary = {
      runId, model: model!, effort: effort ?? null, pilot, dryRun, candidates: all.length, toJudge: todo.length, groups: totals.groups, judged: totals.judged,
      rejected: totals.rejected, failedGroups: totals.failedGroups, matched: totals.matched, vetoes: totals.vetoes, batches: totals.done,
      failedBatches: totals.failedBatches, ...usage, costUsd, wallSeconds, batchStats: [...batchStats].sort((a, b) => a.index - b.index),
      sample: pilot ? `spread sample of ${limit} (seed ${values.seed}) from ${todo.length} new or changed groups` : undefined,
    };
    const files = await writeJudgeReport(OUT_DIR, summary, rows);
    if (rw) {
      await finishJudgeRun(rw, Number(runId), {
        batches: totals.done, groups: totals.groups, judged: totals.judged, rejected: totals.rejected, matched: totals.matched, vetoes: totals.vetoes,
        failedBatches: totals.failedBatches, ...usage, costUsd, reportPath: path.relative(process.cwd(), files.html),
      });
    }
    const per100 = totals.groups > 0 ? (costUsd / totals.groups) * 100 : 0;
    console.log(
      `judge-matches: run ${runId} ${breakerStop ? `stopped by the breaker (${breakerStop})` : stopping ? 'stopped' : budgetStop ? 'stopped at --max-cost' : 'done'}: ` +
        `${totals.groups} groups, ${totals.judged} judged, ${totals.rejected} rejected, ${totals.matched} with a match, ${totals.vetoes} vetoed pairs, ` +
        `${totals.failedBatches} failed batches; tokens ${usage.inputTokens} in, ${usage.cacheReadTokens} cache read, ${usage.cacheWriteTokens} cache write, ` +
        `${usage.outputTokens} out; reported cost $${costUsd.toFixed(4)} ($${per100.toFixed(4)} per 100 groups); ${wallSeconds.toFixed(1)}s`,
    );
    console.log(`report: ${files.html}`);
    console.log(`csv:    ${files.csv}`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
