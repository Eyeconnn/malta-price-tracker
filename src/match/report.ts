// The judge run report for the owner: a standalone HTML page (no external assets) and a CSV with one line per
// listing. Each candidate group shows its listings (shop, title, price), Claude's clusters and the differences it
// listed, the pairs the veto overruled and the clusters kept; the run shows tokens and cost per batch and per 100
// groups.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { csvCell, esc } from '../names/report.js';

export type JudgeBatchStat = {
  index: number;
  groups: number;
  listings: number;
  judged: number;
  rejected: number;
  failed: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  costUsd: number;
  seconds: number;
};

export type JudgeSummary = {
  runId: string;
  model: string;
  effort: string | null;
  pilot: boolean;
  dryRun: boolean;
  /** candidate groups found, and how many are new or changed */
  candidates: number;
  toJudge: number;
  /** groups sent to Claude (in batches that ran), judged (a valid answer), rejected (answer failed the checks) */
  groups: number;
  judged: number;
  rejected: number;
  /** groups of failed batches */
  failedGroups: number;
  /** groups with a cluster of two or more left after the veto */
  matched: number;
  /** pairs the veto overruled */
  vetoes: number;
  batches: number;
  failedBatches: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  /** total_cost_usd as Claude Code reports it */
  costUsd: number;
  wallSeconds: number;
  batchStats: JudgeBatchStat[];
  sample?: string;
};

export type JudgeListingRow = { shop: string; shopId: number; groupKey: string; title: string; priceCents: number | null };

export type JudgeGroupRow = {
  index: number;
  batch: number;
  key: string;
  category: string;
  status: 'ok' | 'rejected' | 'failed';
  reason: string | null;
  listings: JudgeListingRow[];
  /** Claude's clusters (indexes), null without a valid answer */
  clusters: number[][] | null;
  apart: { a: number; b: number; differences: string[] }[];
  vetoed: { a: number; b: number; reasons: string[] }[];
  /** clusters of two or more after the veto */
  final: number[][];
};

const usd = (n: number) => `$${n.toFixed(4)}`;
const int = (n: number) => n.toLocaleString('en-GB');
/** Integer cents as euros, for reading only. */
const euros = (c: number | null) => (c === null ? '' : `&euro;${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`);
const names = (c: number[]) => c.map((i) => String(i + 1)).join(' + ');

export function costPer100Groups(s: JudgeSummary): number {
  return s.groups > 0 ? (s.costUsd / s.groups) * 100 : 0;
}

function groupHtml(r: JudgeGroupRow): string {
  const listings = r.listings
    .map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.shop)}</td><td>${esc(l.title)}</td><td class="num">${euros(l.priceCents)}</td></tr>`)
    .join('');
  const lines: string[] = [];
  if (r.clusters) {
    for (const c of r.clusters) lines.push(c.length > 1 ? `Claude: same ${names(c)}` : `Claude: ${names(c)} alone`);
    for (const d of r.apart) lines.push(`Claude: ${d.a + 1} vs ${d.b + 1} differ: ${d.differences.join('; ') || '(no difference given)'}`);
  }
  const verdict = lines.map((x) => `<li>${esc(x)}</li>`).join('');
  const vetoes = r.vetoed.map((v) => `<li class="veto">${esc(`vetoed ${v.a + 1} + ${v.b + 1}: ${v.reasons.join('; ')}`)}</li>`).join('');
  const kept = r.final.length > 0 ? r.final.map((c) => `<li class="kept">${esc(`kept: ${names(c)}`)}</li>`).join('') : '<li>kept: no match</li>';
  const status = r.status === 'ok' ? '' : `<p class="${r.status}">${esc(r.status)}: ${esc(r.reason ?? '')}</p>`;
  return `<section class="${r.status}"><h3>Group ${r.index} <small>${esc(r.category)}, batch ${r.batch}, ${esc(r.key)}</small></h3>
<table><thead><tr><th>#</th><th>Shop</th><th>Title</th><th>Price</th></tr></thead><tbody>${listings}</tbody></table>
${status}<ul>${verdict}${vetoes}${r.status === 'ok' ? kept : ''}</ul></section>`;
}

export function renderJudgeHtml(s: JudgeSummary, rows: JudgeGroupRow[]): string {
  const facts: [string, string][] = [
    ['Run', s.runId],
    ['Model', s.model],
    ['Effort', s.effort ?? 'CLI default'],
    ['Mode', `${s.pilot ? 'pilot' : 'full'}${s.dryRun ? ', dry run (nothing written)' : ''}`],
    ...(s.sample ? ([['Sample', s.sample]] as [string, string][]) : []),
    ['Candidate groups', `${int(s.candidates)} found, ${int(s.toJudge)} new or changed`],
    ['Groups sent', int(s.groups)],
    ['Judged', int(s.judged)],
    ['Rejected answers', int(s.rejected)],
    ['Groups of failed batches', int(s.failedGroups)],
    ['Groups with a match kept', int(s.matched)],
    ['Vetoed pairs', int(s.vetoes)],
    ['Batches', `${int(s.batches)} (${int(s.failedBatches)} failed)`],
    ['Input tokens', int(s.inputTokens)],
    ['Output tokens', int(s.outputTokens)],
    ['Thinking tokens', int(s.thinkingTokens)],
    ['Cache read / write tokens', `${int(s.cacheReadTokens)} / ${int(s.cacheWriteTokens)}`],
    ['Reported cost', usd(s.costUsd)],
    ['Cost per 100 groups', usd(costPer100Groups(s))],
    ['Wall time', `${s.wallSeconds.toFixed(1)} s`],
  ];
  const batchRows = s.batchStats
    .map(
      (b) => `<tr class="${b.failed ? 'failed' : 'ok'}"><td>${b.index}</td><td>${int(b.groups)}</td><td>${int(b.listings)}</td><td>${int(b.judged)}</td><td>${int(b.rejected)}</td>` +
        `<td>${int(b.inputTokens)}</td><td>${int(b.cacheReadTokens)} / ${int(b.cacheWriteTokens)}</td><td>${int(b.outputTokens)}</td><td>${int(b.thinkingTokens)}</td>` +
        `<td>${usd(b.costUsd)}</td><td>${usd(b.groups > 0 ? (b.costUsd / b.groups) * 100 : 0)}</td><td>${b.seconds.toFixed(1)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Match judge run ${esc(s.runId)} (${esc(s.model)})</title>
<style>
body { font: 14px/1.4 system-ui, sans-serif; margin: 16px; color: #1a1a1a; background: #fff; }
table { border-collapse: collapse; width: 100%; margin-bottom: 8px; }
th, td { border: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; }
th { background: #f3f3f3; }
td.num { text-align: right; white-space: nowrap; }
dl { display: grid; grid-template-columns: max-content auto; gap: 2px 16px; }
dt { font-weight: 600; }
section { border-top: 2px solid #ccc; padding-top: 4px; margin-bottom: 16px; }
section.rejected, section.failed { background: #f7f7f7; }
li.veto { color: #a33; }
li.kept { color: #165f2a; font-weight: 600; }
p.rejected, p.failed { color: #a33; }
small { font-weight: normal; color: #666; }
</style></head><body>
<h1>Match judge run ${esc(s.runId)}</h1>
<dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
<h2>Batches</h2>
<table><thead><tr><th>#</th><th>Groups</th><th>Listings</th><th>Judged</th><th>Rejected</th><th>Input tokens</th><th>Cache read / write</th><th>Output tokens</th><th>Thinking tokens</th><th>Reported cost</th><th>Per 100 groups</th><th>Seconds</th></tr></thead>
<tbody>
${batchRows}
</tbody></table>
<h2>Groups</h2>
${rows.map(groupHtml).join('\n')}
</body></html>
`;
}

export const JUDGE_CSV_HEADER = [
  'group', 'candidate_key', 'category', 'status', 'reason', 'member', 'shop', 'shop_id', 'group_key', 'title', 'price_cents', 'claude_cluster', 'final_cluster',
  'differences', 'vetoed',
];

export function renderJudgeCsv(rows: JudgeGroupRow[]): string {
  const lines = [JUDGE_CSV_HEADER.join(',')];
  for (const r of rows) {
    r.listings.forEach((l, i) => {
      const claude = r.clusters ? r.clusters.findIndex((c) => c.includes(i)) : -1;
      const final = r.final.findIndex((c) => c.includes(i));
      const other = (x: { a: number; b: number }) => (x.a === i ? x.b : x.a);
      const diffs = r.apart.filter((d) => d.a === i || d.b === i).map((d) => `vs ${other(d) + 1}: ${d.differences.join(', ')}`);
      const vetoes = r.vetoed.filter((v) => v.a === i || v.b === i).map((v) => `vs ${other(v) + 1}: ${v.reasons.join(', ')}`);
      lines.push(
        [
          String(r.index), r.key, r.category, r.status, r.reason ?? '', String(i + 1), l.shop, String(l.shopId), l.groupKey, l.title,
          l.priceCents === null ? '' : String(l.priceCents), claude >= 0 ? String(claude + 1) : '', final >= 0 ? String(final + 1) : '', diffs.join('; '), vetoes.join('; '),
        ]
          .map(csvCell)
          .join(','),
      );
    });
  }
  // BOM so Excel on Windows reads UTF-8
  return `﻿${lines.join('\r\n')}\r\n`;
}

const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

/** Writes <dir>/<run id>-<model>.html and .csv; returns both paths. */
export async function writeJudgeReport(dir: string, s: JudgeSummary, rows: JudgeGroupRow[]): Promise<{ html: string; csv: string }> {
  await mkdir(dir, { recursive: true });
  const base = path.join(dir, `${fileSafe(s.runId)}-${fileSafe(s.model)}`);
  const html = `${base}.html`;
  const csv = `${base}.csv`;
  await writeFile(html, renderJudgeHtml(s, rows), 'utf8');
  await writeFile(csv, renderJudgeCsv(rows), 'utf8');
  return { html, csv };
}
