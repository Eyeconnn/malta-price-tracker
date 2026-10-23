// The raw answer of the one real verification call (haiku, effort low, 2 candidate groups, --dry-run, 23 Oct): the
// runner's parser reads it and the judge's checks map it, so the schema and the runner agree with the real CLI.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Candidate, Listing } from '../../src/match/candidates.js';
import { readAnswers, type JudgeBatch } from '../../src/match/judge.js';
import { parseClaudeOutput } from '../../src/names/claude.js';

const raw = readFileSync(new URL('./fixtures/tiny-call-haiku.json', import.meta.url), 'utf8');
const L = (id: number, title: string): Listing => ({
  id, shopId: 1, shopSlug: 's', groupKey: `k${id}`, title, brand: null, category: 'baby', categoryPath: null, gtin: null, mpn: null, priceCents: 1795, variantTitles: [],
});
const C = (key: string, members: Listing[]): Candidate => ({ key, fingerprint: key, category: 'baby', members });

describe('the real verification call', () => {
  it('parses with the runner and maps to clusters and differences', () => {
    const p = parseClaudeOutput(raw);
    expect(p.costUsd).toBeGreaterThan(0);
    expect(p.usage.outputTokens).toBeGreaterThan(0);
    const batch: JudgeBatch = {
      groups: [
        { id: 'G1', candidate: C('a', [1, 2, 3, 4].map((i) => L(i, `Squeasy Snacker 180ml colour ${i}`))) },
        { id: 'G2', candidate: C('b', [L(5, 'Shark HD752EU'), L(6, 'Shark HD446SLEU')]) },
      ],
    };
    const r = readAnswers(batch, p.output);
    expect(r.get('G1')).toEqual({ ok: true, verdict: { clusters: [[0, 1, 2, 3]], apart: [] } });
    const g2 = r.get('G2');
    expect(g2?.ok && g2.verdict.clusters).toEqual([[0], [1]]);
    expect(g2?.ok && g2.verdict.apart[0].differences.length).toBeGreaterThan(0);
  });
});
