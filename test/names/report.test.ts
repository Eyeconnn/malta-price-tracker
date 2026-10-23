import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderCsv, writeReport, type ReportRow, type RunSummary } from '../../src/names/report.js';

const summary: RunSummary = {
  runId: '12', model: 'haiku', effort: 'low', categories: ['laptops', 'toys'], pilot: true, dryRun: true,
  batches: 2, groups: 3, accepted: 2, rejected: 1, failedBatches: 0,
  inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50, thinkingTokens: 300, costUsd: 0.0123, wallSeconds: 42.5,
  batchStats: [
    { index: 1, category: 'laptops', items: 1, accepted: 1, rejected: 0, failed: false, inputTokens: 600, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 50, thinkingTokens: 250, costUsd: 0.0081, seconds: 12.25 },
    { index: 2, category: 'toys', items: 2, accepted: 1, rejected: 1, failed: true, inputTokens: 400, outputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 0, thinkingTokens: 50, costUsd: 0.0042, seconds: 30.25 },
  ],
};

const rows: ReportRow[] = [
  { category: 'laptops', shop: 'scan', sourceTitle: 'LENOVO <script>alert(1)</script>', name: 'Lenovo ThinkBook 16 G6', variantLabel: null, attrs: { ram_gb: 16, colour: ['black'] }, dropped: [], status: 'ok', reason: null, shopId: 7, groupKey: 'g-1', brand: 'Lenovo', brandStatus: 'reliable' },
  { category: 'toys', shop: 'toyshop', sourceTitle: '=HYPERLINK("x")', name: 'LEGO "Technic" 42115', variantLabel: 'Default', attrs: {}, dropped: ['flavour (not in schema)'], status: 'rejected', reason: 'lost tokens: 42115' },
  { category: 'toys', shop: 'toyshop', sourceTitle: 'Barbie, Dream House', name: null, variantLabel: null, attrs: {}, dropped: [], status: 'failed', reason: 'batch failed' },
];

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('writeReport', () => {
  it('writes a standalone HTML report and a CSV named after the run and model', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'names-report-'));
    dirs.push(dir);
    const files = await writeReport(dir, summary, rows);
    expect(path.basename(files.html)).toBe('12-haiku.html');
    expect(path.basename(files.csv)).toBe('12-haiku.csv');

    const html = await readFile(files.html, 'utf8');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toMatch(/<link|<script|src="http/);
    expect(html).toContain('haiku');
    expect(html).toContain('<dt>Effort</dt><dd>low</dd>');
    expect(html).toContain('0.0123');
    expect(html).toContain('0.41'); // cost per 100 groups
    expect(html).toContain('lost tokens: 42115');
    expect(html).toContain('ram_gb: 16');
    // per-batch usage table
    expect(html).toContain('<h2>Batches</h2>');
    expect(html).toContain('<td>1</td><td>laptops</td><td>1</td><td>1</td><td>0</td><td>600</td><td>0 / 50</td><td>300</td><td>250</td><td>$0.0081</td><td>12.3</td>');
    expect(html).toContain('<tr class="failed"><td>2</td>');
    expect(html).toContain('<dt>Thinking tokens</dt><dd>300</dd>');
    expect(html).not.toContain('\u2014');

    const csv = await readFile(files.csv, 'utf8');
    expect(csv.split('\r\n')[0].replace(/^\uFEFF/, '')).toBe('category,shop,source_title,clean_name,variant_label,attributes,dropped_attributes,status,reason,shop_id,group_key,brand,brand_status,canonical_name,canonical_reason');
    // the group ids let a later run pick exactly these groups (--sample-from)
    expect(csv.split('\r\n')[1]).toMatch(/,7,g-1,Lenovo,reliable,,$/);
  });
});

describe('renderCsv', () => {
  it('quotes commas and quotes, and guards cells that would start a spreadsheet formula', () => {
    const csv = renderCsv(rows);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"LEGO ""Technic"" 42115"');
    expect(csv).toContain('"Barbie, Dream House"');
  });
});
