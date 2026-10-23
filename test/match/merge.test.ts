// Split products in judged matching (live check 23 Oct: one iPhone 17 Pro 512GB became two judged products and a
// title group, because its candidate group was cut into chunks judged on their own). Splitting keeps whole model
// families in one chunk (a family larger than the cap is judged through one listing per shop and colour, the other
// colours attached when the veto finds nothing else); the merge pass re-judges clusters from different judgements
// that look like one product, one listing per cluster, and merges only when Claude says same and the veto agrees.
// Claude is simulated: no calls.
import { describe, expect, it } from 'vitest';
import { resolveJudgements, type CurrentListing } from '../../src/match/apply.js';
import { buildCandidates, MAX_GROUP, type Candidate, type Listing } from '../../src/match/candidates.js';
import { judgeMessage, makeJudgeBatches, shownMembers, type JudgeBatch } from '../../src/match/judge.js';
import { mergeCandidateOf, mergeCandidates, overlayJudgements, planMerge, settleMergeBatch } from '../../src/match/merge.js';
import { settleBatch } from '../../src/match/settle.js';
import type { JudgementRow, StoredJudgement } from '../../src/match/store.js';
import { assignMatches } from '../../src/site/matching.js';

let nextId = 1000;
const L = (shop: string, title: string, more: Partial<Listing> = {}): Listing => {
  const id = nextId++;
  const shopId = shop.length * 100 + shop.charCodeAt(0);
  return {
    id, shopId, shopSlug: shop, groupKey: `g${id}`, title, brand: null, category: 'phones', categoryPath: null, gtin: null, mpn: null,
    priceCents: 149900, variantTitles: [], ...more,
  };
};

/** The live iPhone 17 Pro 512GB listings: 12 at 5 shops in several colours. */
function iphone512(): Listing[] {
  return [
    L('atoz', 'APPLE iPhone 17 Pro 512GB-Storage 12GB Smartphone, Silver', { brand: 'APPLE' }),
    L('atoz', 'APPLE iPhone 17 Pro 512GB-Storage 12GB Smartphone, Blue', { brand: 'APPLE' }),
    L('atoz', 'APPLE iPhone 17 Pro 512GB-Storage 12GB Smartphone, Orange', { brand: 'APPLE' }),
    L('intercomp', 'APPLE IPHONE 17 PRO 512GB ORANGE'),
    L('intercomp', 'APPLE IPHONE 17 PRO 512GB SILVER'),
    L('intercomp', 'APPLE IPHONE 17 PRO 512GB DEEP BLUE'),
    L('soundvision', 'Apple iPhone 17 Pro 512GB – Cosmic Orange', { brand: 'Apple' }),
    L('soundvision', 'Apple iPhone 17 Pro 512GB – Deep Blue', { brand: 'Apple' }),
    L('telecom', 'Apple iPhone 17 Pro 512GB Silver', { brand: 'Apple' }),
    L('telecom', 'Apple Iphone 17 Pro 512GB Cosmic Orange', { brand: 'Apple' }),
    L('telecom', 'Apple Iphone 17 Pro 512GB Deep Blue', { brand: 'Apple' }),
    L('epic', 'Apple iPhone 17 Pro 512GB Deep Blue', { brand: 'Apple' }),
  ];
}

/**
 * Other iPhone 17 Pro listings: those without storage in their title join the 512GB candidate group (as on the live
 * data), so it is larger than 12; the 256GB and 1TB ones form groups of their own.
 */
function otherIphones(): Listing[] {
  const out: Listing[] = [
    L('klikk', 'Apple iPhone 17 Pro', { brand: 'Apple', priceCents: 119900 }),
    L('scan', 'Apple iPhone 17 Pro', { brand: 'Apple', priceCents: null }),
    L('epic', 'iPhone 17 Pro', { variantTitles: ['256GB', '512GB', '1TB'], priceCents: 141964 }),
  ];
  for (const shop of ['atoz', 'intercomp', 'telecom', 'soundvision', 'epic']) {
    out.push(L(shop, `Apple iPhone 17 Pro 256GB Silver`, { brand: 'Apple', priceCents: 129900 }));
    out.push(L(shop, `Apple iPhone 17 Pro 1TB Deep Blue`, { brand: 'Apple', priceCents: 179900 }));
  }
  out.push(L('atoz', 'Apple iPhone 17 Pro 256GB Cosmic Orange', { brand: 'Apple', priceCents: 129900 }));
  out.push(L('telecom', 'Apple iPhone 17 Pro 256GB Cosmic Orange', { brand: 'Apple', priceCents: 129900 }));
  return out;
}

const STORAGE = /(\d+)\s*(gb|tb)/i;
/** A careful simulated Claude: listings are the same when their storage and Pro/Max words agree (colour ignored). */
const sameModel = (l: Listing) => {
  const t = l.title.toLowerCase();
  return `${t.match(STORAGE)?.[0].replace(/\s+/g, '') ?? '?'}|${/\bmax\b/.test(t) ? 'max' : ''}|${/\bpro\b/.test(t) ? 'pro' : ''}|${/rugged/.test(t) ? 'rugged' : ''}`;
};

/** Simulated Claude output for a batch: clusters by key over the listings Claude is shown. */
function claude(batch: JudgeBatch, keyOf: (l: Listing) => string) {
  return {
    items: batch.groups.map((g) => {
      const by = new Map<string, string[]>();
      shownMembers(g.candidate).forEach((l, i) => by.set(keyOf(l), [...(by.get(keyOf(l)) ?? []), String(i + 1)]));
      return { group: g.id, clusters: [...by.values()], apart: [] };
    }),
  };
}

const ctx = { model: 'haiku', effort: 'low', batch: 1, firstIndex: 1 };
const current = (list: Listing[]) => new Map<string, CurrentListing>(list.map((l) => [`${l.shopId}|${l.groupKey}`, l]));

/** The judge's first pass: every candidate group judged by the simulated Claude. */
function firstPass(list: Listing[], keyOf: (l: Listing) => string, at = 1): StoredJudgement[] {
  const rows: JudgementRow[] = [];
  for (const b of makeJudgeBatches(buildCandidates(list))) rows.push(...settleBatch(b, claude(b, keyOf), ctx).judgements);
  return overlayJudgements([], rows, new Date(at), false);
}

/** The merge pass over stored judgements; returns the judgements after it and the merge candidates. */
function mergePass(stored: StoredJudgement[], list: Listing[], keyOf: (l: Listing) => string, at = 2) {
  const groups = resolveJudgements(stored, current(list)).groups;
  const { candidates } = mergeCandidates(groups, new Map(list.map((l) => [l.id, l])));
  const rows: JudgementRow[] = [];
  for (const b of makeJudgeBatches(candidates)) rows.push(...settleMergeBatch(b, claude(b, keyOf), ctx).judgements);
  return { stored: overlayJudgements(stored, rows, new Date(at), true), candidates, rows };
}

/** The products the site build makes: listing id to product key. */
function products(stored: StoredJudgement[], list: Listing[]) {
  const judged = resolveJudgements(stored, current(list)).clusters;
  return assignMatches(list, { judged });
}

const productsOf = (m: Map<number, { key: string }>, list: Listing[]) => new Set(list.map((l) => m.get(l.id)?.key ?? `none:${l.id}`));

describe('splitting by model family', () => {
  it('keeps every 512GB listing of the iPhone 17 Pro in one chunk when the candidate group is larger than 12', () => {
    const p512 = iphone512();
    const list = [...p512, ...otherIphones()];
    const cands = buildCandidates(list);
    // the candidate group of 15 was split (in title order its 512GB listings were cut in two)
    expect(cands.length).toBeGreaterThan(1);
    expect(cands.reduce((n, c) => n + c.members.length, 0)).toBeGreaterThan(MAX_GROUP);
    expect(cands.every((c) => shownMembers(c).length <= MAX_GROUP)).toBe(true);
    const ids = new Set(p512.map((l) => l.id));
    const holding = cands.filter((c) => c.members.some((m) => ids.has(m.id)));
    expect(holding).toHaveLength(1);
    expect(holding[0].members.filter((m) => ids.has(m.id))).toHaveLength(12);
  });

  it('ends as one product with the colours of all 5 shops (also the two intercomp listings once left as a title group)', () => {
    const p512 = iphone512();
    const list = [...p512, ...otherIphones()];
    const m = products(firstPass(list, sameModel), list);
    expect(productsOf(m, p512).size).toBe(1);
    expect(p512.every((l) => m.get(l.id)?.method === 'judged')).toBe(true);
    // the 256GB and 1TB ones are products of their own
    const p256 = list.filter((l) => l.title.includes('256GB'));
    expect(productsOf(m, p256).size).toBe(1);
    expect([...productsOf(m, p256)][0]).not.toBe([...productsOf(m, p512)][0]);
  });

  it('judges a family larger than 12 through one listing per shop and colour, the other colours attached', () => {
    const shops = ['atoz', 'intercomp', 'soundvision', 'telecom', 'epic'];
    const fam: Listing[] = [];
    for (const s of shops) for (const c of ['Silver', 'Deep Blue', 'Cosmic Orange']) fam.push(L(s, `Apple iPhone 17 Pro 512GB ${c}`, { brand: 'Apple' }));
    // a second Silver listing at telecom (the same shop and colour listed twice)
    fam.push(L('telecom', 'Apple iPhone 17 Pro 512GB - Silver', { brand: 'Apple' }));
    // a case at one shop shares the family words but the veto keeps it off the phone
    fam.push(L('epic', 'Apple iPhone 17 Pro 512GB Silver Case', { brand: 'Apple', priceCents: 2999 }));
    const cands = buildCandidates(fam);
    const big = cands.find((c) => c.members.length > MAX_GROUP)!;
    expect(big).toBeDefined();
    const shown = shownMembers(big);
    expect(shown.length).toBeLessThanOrEqual(MAX_GROUP);
    // every shop and every colour is shown to Claude
    expect(new Set(shown.map((l) => l.shopSlug)).size).toBe(5);
    expect(new Set(shown.map((l) => l.title.replace(/.*512GB (- )?/, '')))).toEqual(new Set(['Silver', 'Deep Blue', 'Cosmic Orange']));
    // the message holds only the shown listings
    const batch = makeJudgeBatches([big])[0];
    expect(judgeMessage(batch).split('\n')[1].match(/"title"/g)).toHaveLength(shown.length);
    // the case is not attached to a phone
    const caseL = fam.find((l) => l.title.endsWith('Case'))!;
    expect(big.members.some((m) => m.id === caseL.id)).toBe(false);

    const phones = fam.filter((l) => l !== caseL);
    const m = products(firstPass(fam, sameModel), fam);
    expect(productsOf(m, phones).size).toBe(1);
    expect(m.get(caseL.id)?.method).not.toBe('judged');
  });

  it('never attaches a listing whose title differs in more than colour, and attaches nothing where colours name products', () => {
    const shops = ['atoz', 'intercomp', 'soundvision', 'telecom', 'epic'];
    const fam: Listing[] = [];
    for (const s of shops) for (const c of ['Silver', 'Deep Blue', 'Cosmic Orange']) fam.push(L(s, `Apple iPhone 17 Pro 512GB ${c}`, { brand: 'Apple' }));
    const esim = L('telecom', 'Apple iPhone 17 Pro 512GB Silver eSIM', { brand: 'Apple' });
    const big = buildCandidates([...fam, esim]).find((c) => c.reps)!;
    expect(big.members.some((m) => m.id === esim.id)).toBe(false);

    // 14 paints of one range at two shops: each colour is its own product
    const paints: Listing[] = [];
    for (const c of ['Evil Red', 'Bloody Red', 'Dead White', 'Bone White', 'Electric Blue', 'Magic Blue', 'Sun Yellow']) {
      for (const s of ['gamebreaker', 'gamesplus']) paints.push(L(s, `Vallejo Game Color ${c} 18ml`, { brand: 'Vallejo', category: 'gaming', priceCents: 350 }));
    }
    const cands = buildCandidates(paints);
    expect(cands.some((c) => c.reps)).toBe(false);
    expect(cands.every((c) => c.members.length <= MAX_GROUP)).toBe(true);
  });
});

describe('merge pass', () => {
  /** The live split: the family judged in two chunks, two intercomp listings left alone in them. */
  function liveSplit() {
    const p = iphone512();
    const [atS, atB, atO, icO, icS, icDB, svO, svDB, tcS, tcO, tcDB, epDB] = p;
    const chunk1 = [atS, atB, atO, icO, tcS, icS];
    const chunk2 = [icDB, svO, svDB, tcO, tcDB, epDB];
    const rows: JudgementRow[] = [];
    const cand = (members: Listing[]): Candidate => buildCandidates(members)[0];
    // Claude kept intercomp Silver apart in chunk 1 and judged the rest of each chunk the same
    const first = cand(chunk1);
    const second = cand(chunk2);
    const b1 = makeJudgeBatches([first])[0];
    const b2 = makeJudgeBatches([second])[0];
    rows.push(...settleBatch(b1, claude(b1, (l) => (l === icS ? 'apart' : 'same')), ctx).judgements);
    rows.push(...settleBatch(b2, claude(b2, () => 'same'), ctx).judgements);
    return { p, stored: overlayJudgements([], rows, new Date(1), false), icS };
  }

  it('merges the clusters of two chunks into one product when Claude says same; the listing a chunk kept apart stays apart (review M2)', () => {
    const { p, stored, icS } = liveSplit();
    expect(productsOf(products(stored, p), p).size).toBeGreaterThan(1);
    const after = mergePass(stored, p, () => 'same');
    expect(after.candidates).toHaveLength(1);
    // one listing per cluster is shown
    expect(shownMembers(after.candidates[0])).toHaveLength(3);
    expect(after.rows[0].key).toMatch(/^m[0-9a-f]{32}$/);
    // the fingerprint covers every member
    expect(after.rows[0].members).toHaveLength(12);
    const m = products(after.stored, p);
    const rest = p.filter((l) => l !== icS);
    expect(productsOf(m, rest).size).toBe(1);
    // intercomp Silver was judged apart from the chunk 1 cluster side by side: the merge pass does not overrule that
    expect(m.get(icS.id)?.key).not.toBe(m.get(rest[0].id)!.key);
    // the old chunk judgements stay (they are not deleted by a merge), the merge is newer and wins
    expect(after.stored.filter((j) => j.key.startsWith('c'))).toHaveLength(2);
    // a second merge pass finds nothing new to ask
    expect(mergePass(after.stored, p, () => 'same', 3).candidates).toHaveLength(0);
  });

  it('merges the live listings although the colours one shop lists on their own carry their own part numbers of one stem', () => {
    const { p, icS } = liveSplit();
    const mpn: Record<string, string> = { 'APPLE IPHONE 17 PRO 512GB ORANGE': 'MG8M4', 'APPLE IPHONE 17 PRO 512GB DEEP BLUE': 'MG8N4', 'APPLE IPHONE 17 PRO 512GB SILVER': 'MG8K4-E' };
    const withMpn = p.map((l) => (mpn[l.title] ? { ...l, mpn: mpn[l.title] } : l));
    const rows: JudgementRow[] = [];
    for (const part of [withMpn.slice(0, 5).concat(withMpn[8]), withMpn.slice(5, 8).concat(withMpn.slice(9))]) {
      const bt = makeJudgeBatches([buildCandidates(part)[0]])[0];
      rows.push(...settleBatch(bt, claude(bt, () => 'same'), ctx).judgements);
    }
    const stored = overlayJudgements([], rows, new Date(1), false);
    const after = mergePass(stored, withMpn, () => 'same');
    const m = products(after.stored, withMpn);
    // MG8M4 and MG8N4 share their stem; MG8K4-E (intercomp Silver, vetoed apart in chunk 1) does not
    const rest = withMpn.filter((l) => l.id !== icS.id);
    expect(productsOf(m, rest).size).toBe(1);
    expect(m.get(icS.id)?.key).not.toBe(m.get(rest[0].id)!.key);
  });

  it('keeps the clusters apart when Claude says different, and does not ask again', () => {
    const { p, stored } = liveSplit();
    const before = productsOf(products(stored, p), p).size;
    const after = mergePass(stored, p, (l) => String(l.id));
    expect(after.candidates).toHaveLength(1);
    expect(productsOf(products(after.stored, p), p).size).toBe(before);
    expect(mergePass(after.stored, p, () => 'same', 3).candidates).toHaveLength(0);
  });

  it('asks again with every cluster of a merge judgement when a new listing pairs with one of them', () => {
    const { p, stored, icS } = liveSplit();
    const after = mergePass(stored, p, () => 'same');
    // a new shop lists the phone; its own candidate group judged it apart from a phone case
    const x = L('klikk', 'Apple iPhone 17 Pro 512GB Cosmic Orange', { brand: 'Apple' });
    const caseX = L('klikk', 'Apple iPhone 17 Pro 512GB Cosmic Orange Case', { brand: 'Apple', priceCents: 2999 });
    const bt = makeJudgeBatches([buildCandidates([x, caseX])[0]])[0];
    const list = [...p, x, caseX];
    const stored2 = overlayJudgements(after.stored, settleBatch(bt, claude(bt, (l) => String(l.id)), ctx).judgements, new Date(3), false);
    const again = mergePass(stored2, list, () => 'same', 4);
    expect(again.candidates).toHaveLength(1);
    // the two clusters of the merge judgement (the merged one, intercomp Silver) and the new listing
    expect(shownMembers(again.candidates[0])).toHaveLength(3);
    expect(again.candidates[0].members).toHaveLength(13);
    const m = products(again.stored, list);
    expect(productsOf(m, [...p, x].filter((l) => l !== icS)).size).toBe(1);
  });

  it('asks again on the night a re-judged chunk removed the merge, with the fingerprints of the judgements after the first pass (review I3)', () => {
    const { p, stored } = liveSplit();
    const after = mergePass(stored, p, () => 'same');
    // night 2: chunk 1 is judged again (same verdict, newer); saving it removes the merge judgement sharing its listings
    const chunk1 = stored.find((j) => j.members.length === 6 && j.members.some((m) => m.title === 'apple iphone 17 pro 512gb silver'))!;
    const night2 = overlayJudgements(after.stored, [chunk1], new Date(3), false);
    expect(night2.some((j) => j.key.startsWith('m'))).toBe(false);
    const plan = planMerge(night2, p);
    expect(plan.todo).toHaveLength(1);
  });

  it('never merges 256GB and 512GB, also when Claude wrongly says same', () => {
    const a = [L('atoz', 'Apple iPhone 17 Pro 256GB Silver', { brand: 'Apple' }), L('telecom', 'Apple iPhone 17 Pro 256GB Deep Blue', { brand: 'Apple' })];
    const b = [L('epic', 'Apple iPhone 17 Pro 512GB Silver', { brand: 'Apple' }), L('soundvision', 'Apple iPhone 17 Pro 512GB Deep Blue', { brand: 'Apple' })];
    const list = [...a, ...b];
    const stored = overlayJudgements(
      [],
      [a, b].flatMap((ms) => {
        const bt = makeJudgeBatches([buildCandidates(ms)[0]])[0];
        return settleBatch(bt, claude(bt, () => 'same'), ctx).judgements;
      }),
      new Date(1),
      false,
    );
    const pass = mergePass(stored, list, () => 'same');
    expect(pass.candidates).toHaveLength(0);
    // forced into one merge batch, Claude's wrong "same" is vetoed
    const groups = resolveJudgements(stored, current(list)).groups;
    const byId = new Map(list.map((l) => [l.id, l]));
    expect(groups).toHaveLength(2);
    const forced = mergeCandidateOf(groups.map((g) => ({ source: g.key, members: g.ids.map((id) => byId.get(id)!) })));
    const bt = makeJudgeBatches([forced])[0];
    const s = settleMergeBatch(bt, claude(bt, () => 'same'), ctx);
    expect(s.matched).toBe(0);
    expect(s.vetoes).toBeGreaterThan(0);
    const m = products(overlayJudgements(stored, s.judgements, new Date(2), true), list);
    expect(productsOf(m, a).size).toBe(1);
    expect([...productsOf(m, a)][0]).not.toBe([...productsOf(m, b)][0]);
  });

  describe('two different products with similar names in different chunks', () => {
    // the S25 and a rugged S25 the veto cannot tell apart by its shown titles: same brand, same storage, names
    // overlap; only the codes in two other titles tell them apart
    const s25 = () => [
      L('atoz', 'Samsung Galaxy S25 256GB Navy Blue Smartphone', { brand: 'Samsung', priceCents: 89900 }),
      L('telecom', 'Samsung S25 256GB SM-S931B', { brand: 'Samsung', priceCents: 89900 }),
    ];
    const edge = () => [
      L('epic', 'Samsung Galaxy S25 Rugged 256GB Titanium Silver', { brand: 'Samsung', priceCents: 99900 }),
      L('soundvision', 'Samsung S25 Rugged SM-S937B 256GB', { brand: 'Samsung', priceCents: 99900 }),
    ];
    function setup() {
      const a = s25();
      const b = edge();
      const list = [...a, ...b];
      const rows = [a, b].flatMap((ms) => {
        const bt = makeJudgeBatches([buildCandidates(ms)[0]])[0];
        return settleBatch(bt, claude(bt, () => 'same'), ctx).judgements;
      });
      return { a, b, list, stored: overlayJudgements([], rows, new Date(1), false) };
    }

    it('are merge candidates, and stay apart when Claude says different', () => {
      const { a, b, list, stored } = setup();
      const pass = mergePass(stored, list, sameModel);
      expect(pass.candidates).toHaveLength(1);
      const m = products(pass.stored, list);
      expect(productsOf(m, a).size).toBe(1);
      expect(productsOf(m, b).size).toBe(1);
      expect([...productsOf(m, a)][0]).not.toBe([...productsOf(m, b)][0]);
    });

    it('are vetoed when Claude wrongly says same (the codes of two members differ)', () => {
      const { a, b, list, stored } = setup();
      const pass = mergePass(stored, list, () => 'same');
      expect(pass.rows[0].verdict.vetoed.length).toBeGreaterThan(0);
      const m = products(pass.stored, list);
      expect([...productsOf(m, a)][0]).not.toBe([...productsOf(m, b)][0]);
    });
  });
});

describe('overlayJudgements', () => {
  it('replaces judgements as a complete run does: a normal one removes every older one sharing a listing, a merge only older merges', () => {
    const [x, y, z] = [L('a', 'Apple iPhone 17 Pro 512GB Silver'), L('b', 'Apple iPhone 17 Pro 512GB Blue'), L('c', 'Apple iPhone 17 Pro 512GB Orange')];
    const row = (key: string, ms: Listing[]): JudgementRow => ({
      key, fingerprint: 'f', model: 'haiku', effort: null, verdict: { clusters: [ms.map((_, i) => i)], apart: [], vetoed: [], final: [] },
      members: ms.map((m) => ({ shop_id: m.shopId, group_key: m.groupKey, site_product_id: m.id })),
    });
    let s = overlayJudgements([], [row('c1', [x, y]), row('c2', [z])], new Date(1), false);
    s = overlayJudgements(s, [row('m1', [x, y, z])], new Date(2), true);
    expect(s.map((j) => j.key).sort()).toEqual(['c1', 'c2', 'm1']);
    s = overlayJudgements(s, [row('m2', [y, z])], new Date(3), true);
    expect(s.map((j) => j.key).sort()).toEqual(['c1', 'c2', 'm2']);
    s = overlayJudgements(s, [row('c3', [z])], new Date(4), false);
    expect(s.map((j) => j.key).sort()).toEqual(['c1', 'c3']);
  });
});
