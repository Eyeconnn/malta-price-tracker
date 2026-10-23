// How the site build uses stored judgements: only while every member is still listed and the fingerprint of their
// titles and variant titles is current; newest first, each listing in one judgement only; today's veto applied again.
import { describe, expect, it } from 'vitest';
import { resolveJudgements, type CurrentListing } from '../../src/match/apply.js';
import { fingerprint } from '../../src/match/fingerprint.js';
import type { StoredJudgement } from '../../src/match/store.js';

const cur = (id: number, shopId: number, groupKey: string, title: string, more: Partial<CurrentListing> = {}): CurrentListing => ({
  id, shopId, groupKey, title, variantTitles: [], brand: 'Apple', category: 'phones', categoryPath: null, gtin: null, mpn: null, ...more,
});

let n = 0;
function judgement(members: CurrentListing[], clusters: number[][], judgedAt: number): StoredJudgement {
  return {
    id: ++n, key: `c${n}`, judgedAt: new Date(judgedAt), model: 'haiku', effort: 'low', fingerprint: fingerprint(members),
    members: members.map((m) => ({ shop_id: m.shopId, group_key: m.groupKey, site_product_id: m.id })),
    verdict: { clusters, apart: [], vetoed: [], final: clusters.filter((c) => c.length > 1) },
  };
}
const byRef = (list: CurrentListing[]) => new Map(list.map((l) => [`${l.shopId}|${l.groupKey}`, l]));

describe('resolveJudgements', () => {
  const a = cur(10, 1, 'A', 'Apple iPhone 15 128GB Black');
  const b = cur(20, 2, 'B', 'APPLE iPhone 15 128GB Blue');
  const c = cur(30, 3, 'C', 'Apple iPhone 15 128GB');

  it('turns a current judgement into clusters of site_products ids (today ids, found by shop and group key)', () => {
    const j = judgement([a, b], [[0, 1]], 1);
    const moved = { ...b, id: 21 };
    expect(resolveJudgements([j], byRef([a, moved]))).toMatchObject({ clusters: [[10, 21]], used: 1, stale: 0 });
  });

  it('skips a judgement whose member changed title or variants, or left', () => {
    const j = judgement([a, b], [[0, 1]], 1);
    expect(resolveJudgements([j], byRef([a, { ...b, title: 'Apple iPhone 15 Plus 128GB Blue' }]))).toMatchObject({ clusters: [], used: 0, stale: 1 });
    expect(resolveJudgements([j], byRef([a, { ...b, variantTitles: ['Refurbished'] }]))).toMatchObject({ clusters: [], stale: 1 });
    expect(resolveJudgements([j], byRef([a]))).toMatchObject({ clusters: [], stale: 1 });
  });

  it('applies the veto again with the current data (a listing moved to another category)', () => {
    const j = judgement([a, b], [[0, 1]], 1);
    const r = resolveJudgements([j], byRef([a, { ...b, category: 'drinks' }]));
    expect(r.clusters).toEqual([]);
    expect(r.vetoed).toBe(1);
  });

  it('gives each listing to the newest judgement only; an older one keeps the rest of its cluster', () => {
    const older = judgement([a, b, c], [[0, 1, 2]], 1);
    const newer = judgement([b, cur(40, 4, 'D', 'Apple iPhone 15 128GB Green')], [[0], [1]], 2);
    const r = resolveJudgements([newer, older], byRef([a, b, c, cur(40, 4, 'D', 'Apple iPhone 15 128GB Green')]));
    expect(r.clusters).toEqual([[10, 30]]);
    expect(r.used).toBe(2);
  });
});
