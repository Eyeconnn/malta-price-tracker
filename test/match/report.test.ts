// The judge run report for the owner: every group's listings (shop, title, price), Claude's clusters and
// differences, the vetoes, and tokens and cost per batch and per 100 groups.
import { describe, expect, it } from 'vitest';
import { renderJudgeCsv, renderJudgeHtml, type JudgeGroupRow, type JudgeSummary } from '../../src/match/report.js';

const summary: JudgeSummary = {
  runId: 'dry-20261023-1600', model: 'haiku', effort: 'low', pilot: true, dryRun: true, candidates: 900, toJudge: 850, groups: 2, judged: 1, rejected: 1,
  failedGroups: 0, matched: 1, vetoes: 1, batches: 1, failedBatches: 0, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 50,
  thinkingTokens: 0, costUsd: 0.0042, wallSeconds: 12.5,
  batchStats: [{ index: 1, groups: 2, listings: 5, judged: 1, rejected: 1, failed: false, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 50, thinkingTokens: 0, costUsd: 0.0042, seconds: 12.5 }],
};

const rows: JudgeGroupRow[] = [
  {
    index: 1, batch: 1, key: 'cabc', category: 'phones', status: 'ok', reason: null,
    listings: [
      { shop: 'alpha', shopId: 1, groupKey: 'A', title: 'Apple iPhone 15 128GB Black', priceCents: 79900 },
      { shop: 'beta', shopId: 2, groupKey: 'B', title: 'Apple iPhone 15 128GB <script>alert(1)</script>', priceCents: 78950 },
      { shop: 'gamma', shopId: 3, groupKey: 'C', title: '=HYPERLINK("x") iPhone 15 Plus 128GB', priceCents: null },
    ],
    clusters: [[0, 1, 2]],
    apart: [],
    vetoed: [{ a: 0, b: 2, reasons: ['model words none vs plus'] }, { a: 1, b: 2, reasons: ['model words none vs plus'] }],
    final: [[0, 1]],
  },
  {
    index: 2, batch: 1, key: 'cdef', category: 'drinks', status: 'rejected', reason: 'unknown listing id 4',
    listings: [
      { shop: 'alpha', shopId: 1, groupKey: 'D', title: 'Cisk Lager 330ml', priceCents: 150 },
      { shop: 'beta', shopId: 2, groupKey: 'E', title: 'Cisk Lager 330ml Pack of 6', priceCents: 850 },
    ],
    clusters: null, apart: [], vetoed: [], final: [],
  },
];

describe('renderJudgeHtml', () => {
  const html = renderJudgeHtml(summary, rows);
  it('shows the run facts, cost per batch and per 100 groups', () => {
    expect(html).toContain('Reported cost</dt><dd>$0.0042');
    expect(html).toContain('Cost per 100 groups</dt><dd>$0.2100');
    expect(html).toContain('<td>1</td><td>2</td><td>5</td>');
  });
  it('shows each group with its listings, prices, Claude clusters, vetoes and the clusters kept', () => {
    expect(html).toContain('Apple iPhone 15 128GB Black');
    expect(html).toContain('&euro;799.00');
    expect(html).toContain('&euro;789.50');
    expect(html).toContain('Claude: same 1 + 2 + 3');
    expect(html).toContain('vetoed 1 + 3: model words none vs plus');
    expect(html).toContain('kept: 1 + 2');
    expect(html).toContain('unknown listing id 4');
  });
  it('escapes shop text', () => {
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
  });
  it('has no long dashes', () => expect(html).not.toMatch(/[–—]/));
});

describe('renderJudgeCsv', () => {
  const csv = renderJudgeCsv(rows);
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  it('has one line per listing with its clusters, differences and vetoes', () => {
    expect(lines[0]).toBe('group,candidate_key,category,status,reason,member,shop,shop_id,group_key,title,price_cents,claude_cluster,final_cluster,differences,vetoed');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe('1,cabc,phones,ok,,1,alpha,1,A,Apple iPhone 15 128GB Black,79900,1,1,,vs 3: model words none vs plus');
    expect(lines[3]).toContain(`"'=HYPERLINK(""x"") iPhone 15 Plus 128GB"`);
    expect(lines[3]).toMatch(/,1,,,vs 1: model words none vs plus; vs 2: model words none vs plus$/);
    expect(lines[4]).toBe('2,cdef,drinks,rejected,unknown listing id 4,1,alpha,1,D,Cisk Lager 330ml,150,,,,');
  });
});
