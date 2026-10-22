// The run report for the owner: a standalone HTML page (no external assets) and a CSV with the same rows.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type RunSummary = {
  runId: string;
  model: string;
  /** the --effort passed to claude, null for the CLI default */
  effort: string | null;
  categories: string[];
  pilot: boolean;
  dryRun: boolean;
  batches: number;
  groups: number;
  accepted: number;
  rejected: number;
  failedBatches: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  /** total_cost_usd as Claude Code reports it (API prices; on a plan it is what the run would have cost) */
  costUsd: number;
  wallSeconds: number;
  /** usage per batch, in the order they ran */
  batchStats: BatchStat[];
};

export type BatchStat = {
  index: number;
  category: string;
  items: number;
  accepted: number;
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

export type ReportRow = {
  category: string;
  shop: string;
  sourceTitle: string;
  /** the clean name, or what Claude proposed for a rejected row */
  name: string | null;
  variantLabel: string | null;
  attrs: Record<string, unknown>;
  dropped: string[];
  status: 'ok' | 'rejected' | 'failed';
  reason: string | null;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function formatAttrs(attrs: Record<string, unknown>): string {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join('; ');
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const int = (n: number) => n.toLocaleString('en-GB');

export function costPer100(s: RunSummary): number {
  return s.groups > 0 ? (s.costUsd / s.groups) * 100 : 0;
}

export function renderHtml(s: RunSummary, rows: ReportRow[]): string {
  const facts: [string, string][] = [
    ['Run', s.runId],
    ['Model', s.model],
    ['Effort', s.effort ?? 'CLI default'],
    ['Mode', `${s.pilot ? 'pilot' : 'full'}${s.dryRun ? ', dry run (nothing written)' : ''}`],
    ['Categories', s.categories.join(', ')],
    ['Groups', int(s.groups)],
    ['Accepted', int(s.accepted)],
    ['Rejected', int(s.rejected)],
    ['Batches', `${int(s.batches)} (${int(s.failedBatches)} failed)`],
    ['Input tokens', int(s.inputTokens)],
    ['Output tokens', int(s.outputTokens)],
    ['Thinking tokens', int(s.thinkingTokens)],
    ['Cache read / write tokens', `${int(s.cacheReadTokens)} / ${int(s.cacheWriteTokens)}`],
    ['Reported cost', usd(s.costUsd)],
    ['Cost per 100 groups', usd(costPer100(s))],
    ['Wall time', `${s.wallSeconds.toFixed(1)} s`],
  ];
  const batchRows = s.batchStats
    .map(
      (b) => `<tr class="${b.failed ? 'failed' : 'ok'}"><td>${b.index}</td><td>${esc(b.category)}</td><td>${int(b.items)}</td><td>${int(b.accepted)}</td>` +
        `<td>${int(b.rejected)}</td><td>${int(b.inputTokens)}</td><td>${int(b.cacheReadTokens)} / ${int(b.cacheWriteTokens)}</td><td>${int(b.outputTokens)}</td>` +
        `<td>${int(b.thinkingTokens)}</td><td>${usd(b.costUsd)}</td><td>${b.seconds.toFixed(1)}</td></tr>`,
    )
    .join('\n');
  const batchTable = `<h2>Batches</h2>
<table><thead><tr><th>#</th><th>Category</th><th>Items</th><th>Accepted</th><th>Rejected</th><th>Input tokens</th><th>Cache read / write</th><th>Output tokens</th><th>Thinking tokens</th><th>Reported cost</th><th>Seconds</th></tr></thead>
<tbody>
${batchRows}
</tbody></table>`;
  const cats = [...new Set(rows.map((r) => r.category))].sort();
  const sections = cats.map((cat) => {
    const list = rows.filter((r) => r.category === cat);
    const ok = list.filter((r) => r.status === 'ok').length;
    const body = list
      .map(
        (r) => `<tr class="${r.status}"><td>${esc(r.shop)}</td><td>${esc(r.sourceTitle)}</td><td>${esc(r.name ?? '')}</td>` +
          `<td>${esc(r.variantLabel ?? '')}</td><td>${esc(formatAttrs(r.attrs))}${r.dropped.length > 0 ? `<div class="dropped">dropped: ${esc(r.dropped.join('; '))}</div>` : ''}</td>` +
          `<td>${esc(r.status)}</td><td>${esc(r.reason ?? '')}</td></tr>`,
      )
      .join('\n');
    return `<h2>${esc(cat)} <small>${ok} of ${list.length} accepted</small></h2>
<table><thead><tr><th>Shop</th><th>Shop title</th><th>Clean name</th><th>Variant label</th><th>Attributes</th><th>Status</th><th>Reject reason</th></tr></thead>
<tbody>
${body}
</tbody></table>`;
  });

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Name normaliser run ${esc(s.runId)} (${esc(s.model)})</title>
<style>
body { font: 14px/1.4 system-ui, sans-serif; margin: 16px; color: #1a1a1a; background: #fff; }
table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
th, td { border: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; }
th { background: #f3f3f3; position: sticky; top: 0; }
dl { display: grid; grid-template-columns: max-content auto; gap: 2px 16px; }
dt { font-weight: 600; }
tr.rejected td { background: #fff4f2; }
tr.failed td { background: #f4f4f4; color: #666; }
.dropped { color: #a33; font-size: 12px; }
small { font-weight: normal; color: #666; }
</style></head><body>
<h1>Name normaliser run ${esc(s.runId)}</h1>
<dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
${batchTable}
${sections.join('\n')}
</body></html>
`;
}

const CSV_HEADER = ['category', 'shop', 'source_title', 'clean_name', 'variant_label', 'attributes', 'dropped_attributes', 'status', 'reason'];

/** A cell that a spreadsheet could read as a formula gets a leading apostrophe; cells are quoted when needed. */
function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) || safe !== v ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function renderCsv(rows: ReportRow[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      [r.category, r.shop, r.sourceTitle, r.name ?? '', r.variantLabel ?? '', formatAttrs(r.attrs), r.dropped.join('; '), r.status, r.reason ?? '']
        .map(csvCell)
        .join(','),
    );
  }
  // BOM so Excel on Windows reads UTF-8
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

/** Writes <dir>/<run id>-<model>.html and .csv; returns both paths. */
export async function writeReport(dir: string, s: RunSummary, rows: ReportRow[]): Promise<{ html: string; csv: string }> {
  await mkdir(dir, { recursive: true });
  const base = path.join(dir, `${fileSafe(s.runId)}-${fileSafe(s.model)}`);
  const html = `${base}.html`;
  const csv = `${base}.csv`;
  await writeFile(html, renderHtml(s, rows), 'utf8');
  await writeFile(csv, renderCsv(rows), 'utf8');
  return { html, csv };
}
