// pnpm judge-matches --model sonnet [--effort low] [--pilot] [--limit 300] [--seed pilot] [--category phones ...]
//   [--batch-size 15] [--max-listings 120] [--parallel 2] [--max-batches N] [--max-cost 5] [--dry-run] [--timeout 600]
//   [--save-raw] [--merge-pass | --no-merge-pass] [--title "iphone 17 pro"] [--plan]
// Design "Update 23 Oct, afternoon: Claude judges candidate groups side by side". Builds the candidate groups of fresh
// listings (src/match/candidates.ts), skips those whose stored judgement has the current fingerprint, and sends the
// rest to Claude Code (claude -p on the owner's own login, the billing-safe runner of the name normaliser: never
// --bare, allowlisted env, tools off, no MCP servers, no settings, timeouts, process-tree kill) in batches of several
// groups. Claude says which listings are exactly the same product and lists every difference; the veto in code
// (src/match/veto.ts) overrules any "same" the listings' facts contradict. Then the merge pass (src/match/merge.ts):
// clusters of different judgements that look like one product are judged again together, one listing per cluster,
// and merged only when Claude says same and the veto agrees (--no-merge-pass skips it). --merge-pass runs the merge
// pass alone. Both passes share the caps (--max-batches and --max-cost count both, --pilot samples --limit merge
// groups). --title keeps only groups with a listing whose title has the text; --plan prints the plan and calls Claude
// for nothing. Every run
// writes a report to out/judge/. Saved judgements replace older ones sharing their listings only at the end of the run
// (src/match/store.ts supersedeJudgements), so a stopped run keeps every match it did not judge again.
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
import { buildCandidates, spreadSample, type Candidate } from '../match/candidates.js';
import {
  DEFAULT_BATCH_GROUPS,
  DEFAULT_BATCH_LISTINGS,
  judgeJsonSchema,
  judgeMessage,
  judgeSystemPrompt,
  makeJudgeBatches,
  shownMembers,
  type JudgeBatch,
} from '../match/judge.js';
import { loadListings } from '../match/load.js';
import { hasTitle, overlayJudgements, planMerge, settleMergeBatch } from '../match/merge.js';
import { writeJudgeReport, type JudgeBatchStat, type JudgeGroupRow, type JudgeSummary } from '../match/report.js';
import { failedBatch, settleBatch } from '../match/settle.js';
import {
  finishJudgeRun,
  hasJudgeTables,
  loadJudgements,
  loadStoredFingerprints,
  saveJudgements,
  startJudgeRun,
  supersedeJudgements,
  type JudgementRow,
  type StoredJudgement,
} from '../match/store.js';
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
    'merge-pass': { type: 'boolean', default: false },
    'no-merge-pass': { type: 'boolean', default: false },
    title: { type: 'string' },
    plan: { type: 'boolean', default: false },
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
  const mergeOnly = values['merge-pass'];
  const noMerge = values['no-merge-pass'];
  if (mergeOnly && noMerge) throw new Error('--merge-pass and --no-merge-pass exclude each other');
  const planOnly = values.plan;
  const title = values.title?.trim() || undefined;
  const limit = intOption('limit', values.limit, 1, 100000);
  const batchSize = intOption('batch-size', values['batch-size'], 1, 50);
  const maxListings = intOption('max-listings', values['max-listings'], 2, 400);
  const parallel = intOption('parallel', values.parallel, 1, MAX_PARALLEL);
  const maxBatches = values['max-batches'] === undefined ? undefined : intOption('max-batches', values['max-batches'], 1, 100000);
  const maxCost = parseMaxCost(values['max-cost']);
  if (!planOnly) checkRunScope({ dryRun, pilot, maxBatches });
  const timeoutMs = intOption('timeout', values.timeout, 10, 3600) * 1000;
  const slugs = SITE_CATEGORIES.map((c) => c.slug as string);
  const categories = values.category ?? [];
  for (const c of categories) if (!slugs.includes(c)) throw new Error(`unknown --category ${c} (one of ${slugs.join(', ')})`);

  const rw = dryRun || planOnly ? null : db();
  if (rw && !(await hasJudgeTables(rw))) throw new Error('a run that writes needs migration 013 (match_judgements, judge_runs); run pnpm migrate first, or use --dry-run');

  const ro = postgres(env('DASHBOARD_DATABASE_URL'), { max: 2, idle_timeout: 20, connect_timeout: 30, onnotice: () => {} });
  let listings;
  let stored: Map<string, string>;
  let storedJudgements: StoredJudgement[];
  try {
    listings = await loadListings(ro);
    stored = await loadStoredFingerprints(ro);
    storedJudgements = await loadJudgements(ro);
  } finally {
    await ro.end({ timeout: 5 });
  }
  const keep = (c: Candidate) => (categories.length === 0 || categories.includes(c.category)) && (title === undefined || hasTitle(c, title));
  const all = mergeOnly ? [] : buildCandidates(listings).filter(keep);
  const todo = all.filter((c) => stored.get(c.key) !== c.fingerprint);
  const chosen = pilot ? spreadSample(todo, limit, values.seed) : todo;
  const batches = makeJudgeBatches(chosen, batchSize, maxListings).slice(0, maxBatches ?? Infinity);
  const shownCount = (bs: JudgeBatch[]) => bs.reduce((n, b) => n + b.groups.reduce((m, g) => m + shownMembers(g.candidate).length, 0), 0);
  const groupCount = (bs: JudgeBatch[]) => bs.reduce((n, b) => n + b.groups.length, 0);
  console.log(
    `judge-matches: ${listings.length} fresh listings, ${stored.size} judgements stored; ` +
      (mergeOnly
        ? 'merge pass only'
        : `${all.length} candidate groups, ${todo.length} new or changed; ${groupCount(batches)} groups (${shownCount(batches)} listings shown) in ${batches.length} batches`) +
      `, model ${model}, effort ${effort ?? 'CLI default'}${maxCost !== undefined ? `, max cost $${maxCost}` : ''}${pilot ? ', pilot' : ''}` +
      `${title ? `, titles with "${title}"` : ''}${dryRun ? ', dry run (no database writes)' : ''}${planOnly ? ', plan only' : ''}`,
  );
  /** The merge pass's batches over the stored judgements with this run's saved ones overlaid. */
  const mergePlan = (savedRows: JudgementRow[], usedBatches: number) => {
    const plan = planMerge(overlayJudgements(storedJudgements, savedRows, new Date(), false), listings, { categories, title });
    const chosenM = pilot ? spreadSample(plan.todo, limit, `${values.seed}|merge`) : plan.todo;
    const room = maxBatches === undefined ? Infinity : Math.max(0, maxBatches - usedBatches);
    const every = makeJudgeBatches(chosenM, batchSize, maxListings);
    const mb = every.slice(0, room);
    console.log(
      `merge pass: ${plan.stats.clusters} judged clusters with an identity number, ${plan.stats.pairs} pairs of clusters with the same category, brand and numbers, ` +
        `${plan.stats.candidatePairs} candidate pairs; ${plan.candidates.length} merge groups, ${plan.todo.length} new or changed; ` +
        `${groupCount(mb)} groups (${shownCount(mb)} listings shown) in ${mb.length} batches` +
        `${mb.length < every.length ? ` (${every.length - mb.length} more batches left by --max-batches)` : ''}`,
    );
    return { plan, batches: mb };
  };
  if (planOnly) {
    if (!noMerge) mergePlan([], batches.length);
    return;
  }

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
  /** judgements of the first pass that were saved (or would be, in a dry run): the merge pass reads them */
  const saved: JudgementRow[] = [];
  let usage: Usage = NO_USAGE;
  let costUsd = 0;
  const totals = { groups: 0, judged: 0, rejected: 0, failedGroups: 0, matched: 0, vetoes: 0, failedBatches: 0, done: 0 };
  let mergeSummary: JudgeSummary['merge'];
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

  /**
   * Runs one pass's batches with the parallel workers. Batch and report numbers continue from the earlier pass
   * (offset: batches before it, firstGroup: report number of its first group, total: batches of both passes).
   */
  async function runPass(passBatches: JudgeBatch[], kind: 'judge' | 'merge', offset: number, firstGroup: number, total: number) {
    let next = 0;
    const firstIndex: number[] = [];
    passBatches.reduce((n, b, i) => ((firstIndex[i] = n), n + b.groups.length), firstGroup);
    const counts = { merged: 0, groups: 0 };

    async function runBatch(i: number, batch: JudgeBatch) {
      const index = offset + i;
      const t0 = Date.now();
      const call = await callClaude(
        { model: model!, effort, systemPromptFile, mcpConfigFile, jsonSchema, cwd: childCwd, timeoutMs },
        judgeMessage(batch),
        spawnRunner,
        process.env,
        () => stopping,
      );
      const listingsIn = batch.groups.reduce((m, g) => m + shownMembers(g.candidate).length, 0);
      const stat: JudgeBatchStat = {
        index: index + 1, groups: batch.groups.length, listings: listingsIn, judged: 0, rejected: 0, failed: !call.ok, ...call.usage, costUsd: call.costUsd,
        seconds: (Date.now() - t0) / 1000,
      };
      batchStats.push(stat);
      usage = addUsage(usage, call.usage);
      costUsd += call.costUsd;
      totals.done++;
      totals.groups += batch.groups.length;
      counts.groups += batch.groups.length;
      if (values['save-raw']) await writeFile(path.join(rawDir, `batch-${index + 1}.json`), call.raw, 'utf8');
      const tag = `[${kind === 'merge' ? 'merge ' : ''}batch ${index + 1}/${total}] ${batch.groups.length} groups, ${listingsIn} listings shown`;
      const cost = `${call.usage.inputTokens + call.usage.cacheReadTokens + call.usage.cacheWriteTokens} in, ${call.usage.outputTokens} out, $${call.costUsd.toFixed(4)}, ${stat.seconds.toFixed(1)}s`;
      trip(call.ok, call.error);
      if (!call.ok) {
        totals.failedBatches++;
        totals.failedGroups += batch.groups.length;
        rows.push(...failedBatch(batch, call.error ?? 'batch failed', { batch: index + 1, firstIndex: firstIndex[i] }));
        console.log(`${tag}: FAILED after ${call.attempts} attempts (${call.error}), ${cost}`);
        return;
      }
      const sctx = { model: model!, effort: effort ?? null, batch: index + 1, firstIndex: firstIndex[i] };
      const s = kind === 'merge' ? settleMergeBatch(batch, call.output, sctx) : settleBatch(batch, call.output, sctx);
      rows.push(...s.rows);
      totals.judged += s.judged;
      totals.rejected += s.rejected;
      totals.matched += s.matched;
      totals.vetoes += s.vetoes;
      if (kind === 'merge') counts.merged += s.matched;
      stat.judged = s.judged;
      stat.rejected = s.rejected;
      let note = '';
      if (rw) {
        const r = await saveJudgements(rw, Number(runId), s.judgements);
        note = `, ${r.saved} saved`;
      }
      // the merge pass reads only judgements that were saved (or would be, in a dry run; review M3)
      if (kind === 'judge') saved.push(...s.judgements);
      const what = kind === 'merge' ? `${s.matched} with a merge` : `${s.matched} with a match`;
      console.log(`${tag}: ${s.judged} judged, ${s.rejected} rejected, ${what}, ${s.vetoes} vetoed pairs${note}, ${cost} (${totals.done}/${total} done)`);
    }

    async function worker() {
      while (!stopping && next < passBatches.length) {
        if (budgetReached(costUsd, maxCost)) {
          if (!budgetStop) console.log(`judge-matches: reported cost $${costUsd.toFixed(4)} reached --max-cost $${maxCost}; no new batches`);
          budgetStop = true;
          break;
        }
        const i = next++;
        try {
          await runBatch(i, passBatches[i]);
        } catch (e) {
          totals.failedBatches++;
          console.log(`[batch ${offset + i + 1}/${total}] error: ${(e as Error).message}`);
          trip(false, (e as Error).message);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(parallel, passBatches.length) }, worker));
    return counts;
  }

  try {
    await runPass(batches, 'judge', 0, 1, batches.length);
    if (noMerge) console.log('judge-matches: merge pass off (--no-merge-pass)');
    else if (!stopping && !budgetStop) {
      const m = mergePlan(saved, totals.done);
      const counts = await runPass(m.batches, 'merge', totals.done, groupCount(batches) + 1, totals.done + m.batches.length);
      mergeSummary = {
        clusters: m.plan.stats.clusters, pairs: m.plan.stats.pairs, candidatePairs: m.plan.stats.candidatePairs, candidates: m.plan.candidates.length,
        toJudge: m.plan.todo.length, groups: counts.groups, merged: counts.merged,
      };
    } else console.log('judge-matches: merge pass skipped (the run was stopped)');
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
    // older judgements the saved ones replace go only now (review I4): after a stopped, capped or failing run only
    // those whose every listing was judged again
    if (rw) {
      const complete = !stopping && !budgetStop && !breakerStop && totals.failedBatches === 0;
      try {
        const removed = await supersedeJudgements(rw, { complete });
        console.log(`judge-matches: ${removed} older judgements replaced${complete ? '' : ' (only those wholly judged again: the run did not finish every batch)'}`);
      } catch (e) {
        console.log(`judge-matches: older judgements not removed (${(e as Error).message}); the next run removes them`);
      }
    }
    await finalize();
  }
  if (breakerStop || (totals.done > 0 && totals.failedBatches === totals.done)) process.exitCode = 1;

  async function finalize() {
    const wallSeconds = (Date.now() - started) / 1000;
    rows.sort((a, b) => a.index - b.index);
    const summary: JudgeSummary = {
      runId, model: model!, effort: effort ?? null, pilot, dryRun, candidates: all.length, toJudge: todo.length, groups: totals.groups, judged: totals.judged,
      rejected: totals.rejected, failedGroups: totals.failedGroups, matched: totals.matched, vetoes: totals.vetoes, batches: totals.done,
      failedBatches: totals.failedBatches, ...usage, costUsd, wallSeconds, batchStats: [...batchStats].sort((a, b) => a.index - b.index),
      sample: pilot ? `spread sample of ${limit} (seed ${values.seed}) from ${todo.length} new or changed groups` : undefined,
      merge: mergeSummary,
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
        `${mergeSummary ? `merge pass ${mergeSummary.groups} groups, ${mergeSummary.merged} with a merge, ` : ''}` +
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
