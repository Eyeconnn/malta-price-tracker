// pnpm normalise-names --model haiku [--effort low] [--pilot] [--limit 500] [--sample-from out/names/<run>.csv]
//   [--category laptops ...] [--batch-size 40] [--parallel 2] [--max-batches N] [--dry-run] [--seed pilot] [--timeout 300]
//   [--save-raw]
// Sends batches of one site category's product groups to Claude Code (claude -p, on the owner's own login) for clean
// names and the category's attributes, checks every answer (src/names/check.ts) and writes a report to out/names/.
// Reads with DASHBOARD_DATABASE_URL (read-only role). Without --dry-run, writes product_names and name_runs with
// DATABASE_URL; such a run needs --pilot, --sample-from or --max-batches. Ctrl+C stops after the running batches; a
// second Ctrl+C quits at once and kills the running claude processes with everything they started.
// --sample-from takes exactly the groups of an earlier run's CSV (by shop_id and group_key, or by shop and title for
// CSVs written before those columns), new or changed or not. Every group's category is today's categorize(), not the
// stored site_products.category; the run prints how many sample groups changed category against the CSV.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { closeDb, db } from '../db.js';
import { env } from '../env.js';
import { SITE_CATEGORIES } from '../site/categories.js';
import { brandStatus, loadBrandContext } from '../names/brand.js';
import { checkBatch } from '../names/check.js';
import { addUsage, callClaude, killAllChildren, NO_USAGE, spawnRunner, type Usage } from '../names/claude.js';
import { checkRunScope, parseEffort } from '../names/options.js';
import { makeBatches, systemPrompt, userMessage, type Batch } from '../names/prompt.js';
import { writeReport, type BatchStat, type ReportRow } from '../names/report.js';
import { answerJsonSchema, loadAttributeSchemas } from '../names/schema.js';
import { pickSample, readSampleCsv } from '../names/sample.js';
import { changedGroups, loadGroups, pilotSample, type GroupInput } from '../names/select.js';
import { finishRun, saveResults, startRun } from '../names/store.js';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    effort: { type: 'string' },
    pilot: { type: 'boolean', default: false },
    limit: { type: 'string', default: '500' },
    'sample-from': { type: 'string' },
    category: { type: 'string', multiple: true },
    'batch-size': { type: 'string', default: '40' },
    parallel: { type: 'string', default: '2' },
    'max-batches': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    seed: { type: 'string', default: 'pilot' },
    timeout: { type: 'string', default: '300' },
    'save-raw': { type: 'boolean', default: false },
  },
});

const OUT_DIR = path.resolve('out/names');
const MAX_PARALLEL = 6;

function intOption(name: string, raw: string | undefined, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} needs a whole number from ${min} to ${max}, got ${raw}`);
  return n;
}

/** Batches interleaved across categories, so a --max-batches cap keeps the spread. */
function interleave(batches: Batch[]): Batch[] {
  const byCat = new Map<string, Batch[]>();
  for (const b of batches) {
    const list = byCat.get(b.category);
    if (list) list.push(b);
    else byCat.set(b.category, [b]);
  }
  const lists = [...byCat.values()];
  const out: Batch[] = [];
  for (let i = 0; out.length < batches.length; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

/** The report columns that identify a group and its brand. */
const ids = (g: GroupInput) => ({ shopId: g.shopId, groupKey: g.groupKey, brand: g.brand, brandStatus: g.brandStatus });

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

async function main() {
  const model = values.model?.trim();
  if (!model) throw new Error('--model is required (for example haiku, sonnet, opus)');
  if (!/^[A-Za-z0-9._\-[\]]+$/.test(model)) throw new Error(`--model has unexpected characters: ${model}`);
  const effort = parseEffort(values.effort);
  const sampleFrom = values['sample-from'];
  // a sample run is bounded like a pilot
  const pilot = values.pilot || sampleFrom !== undefined;
  const dryRun = values['dry-run'];
  const limit = intOption('limit', values.limit, 1, 100000);
  const batchSize = intOption('batch-size', values['batch-size'], 1, 100);
  const parallel = intOption('parallel', values.parallel, 1, MAX_PARALLEL);
  const maxBatches = values['max-batches'] === undefined ? undefined : intOption('max-batches', values['max-batches'], 1, 100000);
  checkRunScope({ dryRun, pilot, maxBatches });
  const timeoutMs = intOption('timeout', values.timeout, 10, 3600) * 1000;
  const slugs = SITE_CATEGORIES.map((c) => c.slug as string);
  const categories = values.category ?? [];
  for (const c of categories) if (!slugs.includes(c)) throw new Error(`unknown --category ${c} (one of ${slugs.join(', ')})`);

  const schemas = await loadAttributeSchemas();
  const ro = postgres(env('DASHBOARD_DATABASE_URL'), { max: 2, idle_timeout: 20, connect_timeout: 30, onnotice: () => {} });
  const sampleText = sampleFrom === undefined ? null : await readFile(sampleFrom, 'utf8');
  let groupsAll: GroupInput[];
  let brandCtx: Awaited<ReturnType<typeof loadBrandContext>>;
  try {
    groupsAll = await loadGroups(ro, { categories });
    brandCtx = await loadBrandContext(ro);
  } finally {
    await ro.end({ timeout: 5 });
  }
  const recategorised = groupsAll.filter((g) => g.storedCategory !== undefined && g.storedCategory !== g.category).length;
  console.log(`normalise-names: ${recategorised} of ${groupsAll.length} fresh groups have another category with today's rules than the stored one`);
  const candidates = changedGroups(groupsAll);
  let chosen: GroupInput[];
  let sampleNote: string | undefined;
  if (sampleText !== null) {
    const rows = readSampleCsv(sampleText);
    const pick = pickSample(groupsAll, rows);
    chosen = pick.chosen;
    const moves = new Map<string, number>();
    for (const c of pick.changedCategory) moves.set(`${c.from} -> ${c.to}`, (moves.get(`${c.from} -> ${c.to}`) ?? 0) + 1);
    sampleNote = `${sampleFrom}: ${pick.matched} of ${rows.length} groups matched (${pick.byIds} by shop_id and group_key, ` +
      `${pick.matched - pick.byIds} by shop and title); ${pick.changedCategory.length} changed category against the CSV`;
    console.log(`normalise-names: sample ${sampleNote}`);
    if (moves.size > 0) console.log(`  category changes: ${[...moves].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    if (pick.missing.length > 0) console.log(`  not found: ${pick.missing.slice(0, 10).map((m) => `${m.shop} "${m.sourceTitle}"`).join('; ')}${pick.missing.length > 10 ? ' ...' : ''}`);
  } else chosen = values.pilot ? pilotSample(candidates, limit, values.seed) : candidates;
  for (const g of chosen) {
    const v = brandStatus(g.brand, g.shopId, brandCtx);
    g.brandStatus = v.status;
    g.brandNote = v.why;
  }
  const batches = interleave(makeBatches(chosen, batchSize)).slice(0, maxBatches ?? Infinity);
  const runCats = [...new Set(batches.map((b) => b.category))];
  const groupCount = batches.reduce((n, b) => n + b.items.length, 0);
  console.log(
    `normalise-names: ${groupsAll.length} fresh groups, ${candidates.length} new or changed; ` +
      `${groupCount} groups in ${batches.length} batches (${runCats.join(', ') || 'none'}), model ${model}, effort ${effort ?? 'CLI default'}` +
      `${pilot ? ', pilot' : ''}${dryRun ? ', dry run (no database writes)' : ''}`,
  );
  if (batches.length === 0) return;

  const work = await mkdtemp(path.join(tmpdir(), 'names-run-'));
  const mcpConfigFile = path.join(work, 'mcp.json');
  await writeFile(mcpConfigFile, JSON.stringify({ mcpServers: {} }), 'utf8');
  const perCategory = new Map<string, { systemPromptFile: string; jsonSchema: string }>();
  for (const cat of runCats) {
    const systemPromptFile = path.join(work, `system-${cat}.txt`);
    await writeFile(systemPromptFile, systemPrompt(cat, schemas[cat]), 'utf8');
    perCategory.set(cat, { systemPromptFile, jsonSchema: JSON.stringify(answerJsonSchema(schemas[cat])) });
  }
  // the child runs in an empty folder, so no project files (CLAUDE.md, .mcp.json) are near it
  const childCwd = path.join(work, 'cwd');
  await mkdir(childCwd);

  const rw = dryRun ? null : db();
  const runId = rw ? String(await startRun(rw, { model, categories: runCats, pilot, effort: effort ?? null })) : `dry-${stamp()}`;
  const rawDir = path.join(OUT_DIR, `${runId}-${model.replace(/[^A-Za-z0-9._-]+/g, '_')}-raw`);
  if (values['save-raw']) await mkdir(rawDir, { recursive: true });

  let stopping = false;
  // a second Ctrl+C or any exit kills the running claude processes and everything they started
  process.on('exit', () => killAllChildren(true));
  process.on('SIGINT', () => {
    if (stopping) {
      killAllChildren(true);
      process.exit(130);
    }
    stopping = true;
    console.log('normalise-names: stopping after the running batches (Ctrl+C again to quit now)');
  });

  const started = Date.now();
  const rows: ReportRow[] = [];
  let usage: Usage = NO_USAGE;
  let costUsd = 0;
  let accepted = 0;
  let rejected = 0;
  let failedBatches = 0;
  let done = 0;
  let next = 0;
  const batchStats: BatchStat[] = [];

  async function runBatch(index: number, batch: Batch) {
    const t0 = Date.now();
    const cat = perCategory.get(batch.category)!;
    const call = await callClaude({ model: model!, effort, ...cat, mcpConfigFile, cwd: childCwd, timeoutMs }, userMessage(batch), spawnRunner, process.env, () => stopping);
    const stat: BatchStat = {
      index: index + 1, category: batch.category, items: batch.items.length, accepted: 0, rejected: 0, failed: !call.ok,
      ...call.usage, costUsd: call.costUsd, seconds: (Date.now() - t0) / 1000,
    };
    batchStats.push(stat);
    usage = addUsage(usage, call.usage);
    costUsd += call.costUsd;
    if (values['save-raw']) await writeFile(path.join(rawDir, `batch-${index + 1}.json`), call.raw, 'utf8');
    const tag = `[batch ${index + 1}/${batches.length}] ${batch.category} ${batch.items.length} groups`;
    const cost = `${call.usage.inputTokens + call.usage.cacheReadTokens + call.usage.cacheWriteTokens} in, ${call.usage.outputTokens} out, $${call.costUsd.toFixed(4)}, ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    done++;
    if (!call.ok) {
      failedBatches++;
      for (const { group } of batch.items) {
        rows.push({
          category: batch.category, shop: group.shopSlug, sourceTitle: group.title, name: null, variantLabel: null, attrs: {}, dropped: [],
          status: 'failed', reason: call.error ?? 'batch failed', ...ids(group),
        });
      }
      console.log(`${tag}: FAILED after ${call.attempts} attempts (${call.error}), ${cost}`);
      return;
    }
    const { results, unknownKeys } = checkBatch(batch, call.output, schemas[batch.category]);
    const ok = results.filter((r) => r.status === 'ok').length;
    accepted += ok;
    rejected += results.length - ok;
    stat.accepted = ok;
    stat.rejected = results.length - ok;
    for (const r of results) {
      rows.push({
        category: batch.category, shop: r.item.group.shopSlug, sourceTitle: r.item.group.title, name: r.proposedName,
        variantLabel: r.status === 'ok' ? r.variantLabel : r.proposedLabel, attrs: r.attrs, dropped: r.dropped, status: r.status, reason: r.reason,
        ...ids(r.item.group),
      });
    }
    if (rw) {
      await saveResults(rw, Number(runId), model!, results.map((r) => ({
        group: r.item.group, category: batch.category, status: r.status, displayName: r.displayName,
        variantLabel: r.variantLabel, attrs: r.attrs, reason: r.reason,
      })));
    }
    const extra = unknownKeys.length > 0 ? `, ignored unknown keys ${unknownKeys.join(' ')}` : '';
    console.log(`${tag}: ${ok} ok, ${results.length - ok} rejected${extra}, ${cost} (${done}/${batches.length} done)`);
  }

  async function worker() {
    while (!stopping && next < batches.length) {
      const i = next++;
      try {
        await runBatch(i, batches[i]);
      } catch (e) {
        failedBatches++;
        console.log(`[batch ${i + 1}/${batches.length}] error: ${(e as Error).message}`);
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(parallel, batches.length) }, worker));
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const wallSeconds = (Date.now() - started) / 1000;
  const items = accepted + rejected;
  rows.sort((a, b) => a.category.localeCompare(b.category) || a.shop.localeCompare(b.shop) || a.sourceTitle.localeCompare(b.sourceTitle));
  const summary = {
    runId, model, effort: effort ?? null, categories: runCats, pilot, dryRun, batches: done, groups: items, accepted, rejected, failedBatches,
    ...usage, costUsd, wallSeconds, batchStats: [...batchStats].sort((a, b) => a.index - b.index), sample: sampleNote,
  };
  const files = await writeReport(OUT_DIR, summary, rows);
  if (rw) {
    await finishRun(rw, Number(runId), {
      batches: done, items, accepted, rejected, failedBatches, ...usage, costUsd, reportPath: path.relative(process.cwd(), files.html),
    });
  }
  const per100 = items > 0 ? (costUsd / items) * 100 : 0;
  console.log(
    `normalise-names: run ${runId} ${stopping ? 'stopped' : 'done'}: ${items} groups, ${accepted} accepted, ${rejected} rejected, ` +
      `${failedBatches} failed batches; tokens ${usage.inputTokens} in, ${usage.cacheReadTokens} cache read, ` +
      `${usage.cacheWriteTokens} cache write, ${usage.outputTokens} out; reported cost $${costUsd.toFixed(4)} ` +
      `($${per100.toFixed(4)} per 100 groups); ${wallSeconds.toFixed(1)}s`,
  );
  console.log(`report: ${files.html}`);
  console.log(`csv:    ${files.csv}`);
  if (done > 0 && failedBatches === done) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
