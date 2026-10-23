// One judged batch turned into report rows and judgement rows: Claude's answer read, the veto applied, the members
// stored with shop id, group key and site_products id.
import { describe, expect, it } from 'vitest';
import type { Candidate, Listing } from '../../src/match/candidates.js';
import { makeJudgeBatches } from '../../src/match/judge.js';
import { failedBatch, settleBatch } from '../../src/match/settle.js';

let nextId = 100;
const L = (shop: number, title: string, more: Partial<Listing> = {}): Listing => {
  const id = nextId++;
  return { id, shopId: shop, shopSlug: `s${shop}`, groupKey: `k${id}`, title, brand: 'Apple', category: 'phones', categoryPath: null, gtin: null, mpn: null, priceCents: 70000 + id, variantTitles: [], ...more };
};
const C = (key: string, members: Listing[]): Candidate => ({ key, fingerprint: `fp-${key}`, category: 'phones', members });

const phones = C('cphones', [L(1, 'Apple iPhone 15 128GB Black'), L(2, 'APPLE iPhone 15 128GB Blue'), L(3, 'Apple iPhone 15 Plus 128GB Black')]);
const drinks = C('cdrinks', [L(1, 'Cisk Lager 330ml', { category: 'drinks', brand: 'Cisk' }), L(2, 'Cisk Lager 330ml Pack of 6', { category: 'drinks', brand: 'Cisk' })]);
const batch = makeJudgeBatches([phones, drinks])[0];

describe('settleBatch', () => {
  it('applies the veto to what Claude calls the same, and stores every valid answer', () => {
    const r = settleBatch(batch, { items: [{ group: 'G1', clusters: [['1', '2', '3']], apart: [] }, { group: 'G2', clusters: [['1', '2']], apart: [] }] }, { model: 'haiku', effort: 'low', batch: 3, firstIndex: 10 });
    expect(r.judged).toBe(2);
    expect(r.rejected).toBe(0);
    expect(r.matched).toBe(1);
    expect(r.vetoes).toBe(3);
    expect(r.rows.map((x) => [x.index, x.batch, x.key, x.status, x.final])).toEqual([
      [10, 3, 'cphones', 'ok', [[0, 1]]],
      [11, 3, 'cdrinks', 'ok', []],
    ]);
    expect(r.rows[0].listings[0]).toEqual({ shop: 's1', shopId: 1, groupKey: phones.members[0].groupKey, title: 'Apple iPhone 15 128GB Black', priceCents: phones.members[0].priceCents });
    expect(r.judgements.map((j) => j.key)).toEqual(['cphones', 'cdrinks']);
    const [j] = r.judgements;
    expect(j).toMatchObject({ fingerprint: 'fp-cphones', model: 'haiku', effort: 'low' });
    expect(j.members[2]).toEqual({ shop_id: 3, group_key: phones.members[2].groupKey, site_product_id: phones.members[2].id });
    expect(j.verdict.clusters).toEqual([[0, 1, 2]]);
    expect(j.verdict.final).toEqual([[0, 1]]);
    expect(j.verdict.vetoed.map((v) => [v.a, v.b])).toEqual([[0, 2], [1, 2]]);
  });

  it('reports a rejected answer and stores nothing for it', () => {
    const r = settleBatch(batch, { items: [{ group: 'G1', clusters: [['1', '7']], apart: [] }] }, { model: 'haiku', effort: null, batch: 1, firstIndex: 1 });
    expect(r.rows.map((x) => [x.status, x.reason])).toEqual([
      ['rejected', 'unknown listing id 7'],
      ['rejected', 'no answer for the group'],
    ]);
    expect(r.judgements).toEqual([]);
    expect(r.rejected).toBe(2);
  });
});

describe('failedBatch', () => {
  it('reports every group of a failed batch with the error', () => {
    const rows = failedBatch(batch, 'claude timed out after 600s', { batch: 2, firstIndex: 5 });
    expect(rows.map((x) => [x.index, x.status, x.reason, x.clusters])).toEqual([
      [5, 'failed', 'claude timed out after 600s', null],
      [6, 'failed', 'claude timed out after 600s', null],
    ]);
  });
});
