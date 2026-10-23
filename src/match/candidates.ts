// Candidate groups for pnpm judge-matches (design "Update 23 Oct, afternoon", point 1): listings at different shops
// (and colour or size listings at one shop) that are likely the same product. They come from the title-similarity
// groups of src/site/matching.ts and from model codes shared by listings of the same or a neighbouring category,
// never across two brands. Claude is shown at most MAX_GROUP listings per group: a larger group is split by brand,
// then by model code, then into chunks of whole model families (same brand, storage or size, model numbers and words;
// colours differ), so the colours of one model are never judged apart (live check 23 Oct, split iPhone). A family
// larger than MAX_GROUP is shown through one listing per shop and colour (fewer when needed), the family's other
// listings attached to their shop's shown listing when the veto finds no difference. Groups whose every listing is
// already matched by one barcode or part number are left out. Pure: src/match/load.ts reads the listings.
import { createHash } from 'node:crypto';
import { canonText } from '../names/canon-text.js';
import { titleGroups, titleTokens } from '../site/matching.js';
import { candidateKey, fingerprint } from './fingerprint.js';
import { colourWords, identityOf, modelCodes, sameOrNeighbour, vetoReasons, withoutColours } from './veto.js';
import { vetoListing } from './settle.js';

/** One fresh site_products row of a visible shop, with what the judge sends Claude. */
export type Listing = {
  /** site_products.id */
  id: number;
  shopId: number;
  shopSlug: string;
  groupKey: string;
  title: string;
  brand: string | null;
  /** site category slug (site_products.category) */
  category: string;
  categoryPath: string | null;
  gtin: string | null;
  mpn: string | null;
  /** current price in integer cents */
  priceCents: number | null;
  variantTitles: string[];
  /** the accepted clean name and attributes (product_names), when there are */
  cleanName?: string | null;
  attrs?: Record<string, unknown> | null;
  /** the match of the last site build */
  canonicalId?: string | null;
  matchMethod?: string | null;
};

/**
 * A candidate group. members: every listing the judgement covers (sorted by id). reps: when set, the indexes of the
 * members Claude is shown (a family larger than MAX_GROUP, or one listing per cluster in the merge pass), and
 * attached[i] the members that follow reps[i] into its cluster. merge: a merge-pass group (src/match/merge.ts).
 */
export type Candidate = {
  key: string;
  fingerprint: string;
  category: string;
  members: Listing[];
  reps?: number[];
  attached?: number[][];
  /** sources: the judgements its clusters came from; repSources[i]: the judgement of reps[i]'s cluster */
  merge?: { sources: string[]; repSources: string[] };
};

export const MAX_GROUP = 12;
/** Candidate model codes are at least this long (s24 alone links every S24 case). */
const MIN_CODE = 4;
/** A code shared by more listings than this is a family or chip name, not one product. */
const MAX_CODE_SHARE = 40;

/** Feature and standard codes many products share (5-in-1, IP68, USB3, Wi-Fi 6, DDR5, PCIe 4, HDMI 2.1, Cat6, Gen4). */
const FEATURE_CODE = /^(?:\d+in\d+|ip\d+[a-z]?|usb\d*[a-z]?\d*|wifi\d+[a-z]?|ddr\d+[a-z]?|lpddr\d+[a-z]?|gddr\d+[a-z]?|pcie\d+|hdmi\d+|cat\d+[a-z]?|gen\d+|bt\d+|qi\d+|x\d{2,3})$/;

/** Model codes (src/match/veto.ts) of 4 or more characters, and set or article numbers of 5 to 8 digits. */
export function candidateCodes(title: string): string[] {
  const out = new Set(modelCodes(title).filter((c) => c.length >= MIN_CODE && !FEATURE_CODE.test(c)));
  for (const t of canonText(title).split(/[^\p{L}\p{N}]+/u)) if (/^\d{5,8}$/.test(t)) out.add(t);
  return [...out].sort();
}

const compact = (s: string | null | undefined) => (s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Two listings may be one product: same or neighbouring category, and no two different brands. */
function compatible(a: Listing, b: Listing): boolean {
  if (!sameOrNeighbour(a.category, b.category)) return false;
  const ba = compact(a.brand);
  const bb = compact(b.brand);
  if (ba === '' || bb === '' || ba === bb || ba.includes(bb) || bb.includes(ba)) return true;
  return compact(b.title).includes(ba) || compact(a.title).includes(bb);
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

function groupBy<T>(items: T[], keyOf: (t: T) => string): T[][] {
  const m = new Map<string, T[]>();
  for (const t of items) {
    const k = keyOf(t);
    const l = m.get(k);
    if (l) l.push(t);
    else m.set(k, [t]);
  }
  return [...m.values()];
}

const titleOrder = (a: Listing, b: Listing) => canonText(a.title).localeCompare(canonText(b.title)) || a.id - b.id;

/** Shared title words over all title words of two listings. */
function similarity(a: Listing, b: Listing): number {
  const x = new Set(titleTokens(a.title));
  const y = new Set(titleTokens(b.title));
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.max(1, x.size + y.size - both);
}

/** A part of a split group: its listings and, for a family larger than MAX_GROUP, the ones Claude is shown with the
 * listings attached to each. */
export type Part = { members: Listing[]; reps?: Listing[]; attached?: Listing[][] };

/** Families this similar or more share a chunk when there is room (an unrelated family starts its own). */
const FAMILY_AFFINITY = 0.3;

/**
 * Splits a group larger than MAX_GROUP by brand, then into chunks of whole model families (see familyKey), similar
 * families together; a family larger than MAX_GROUP becomes a part of its own shown through representatives
 * (familyParts). A listing left alone by the split is judged with the part most like it that still has room
 * (review minor).
 */
export function splitGroup(members: Listing[], codesOf: (l: Listing) => string[]): Part[] {
  if (members.length <= MAX_GROUP) return [{ members }];
  const parts = splitParts(members, codesOf);
  const plain = parts.filter((p) => !p.reps);
  const groups = [...parts.filter((p) => p.reps), ...plain.filter((p) => p.members.length >= 2)];
  const alone = plain.filter((p) => p.members.length === 1).map((p) => p.members[0]);
  for (const l of alone) {
    let best: Part | null = null;
    let score = 0;
    for (const g of groups) {
      if (g.reps || g.members.length >= MAX_GROUP) continue;
      const s = Math.max(...g.members.map((m) => similarity(l, m)));
      if (s > score) {
        score = s;
        best = g;
      }
    }
    if (best) best.members.push(l);
    else groups.push({ members: [l] });
  }
  return groups;
}

/** The brand of a listing within a group: its brand field, else a brand of the group its title starts with, else its first word. */
function brandKeyIn(group: Listing[]): (l: Listing) => string {
  const brands = [...new Set(group.map((m) => compact(m.brand)).filter((b) => b !== ''))].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return (l) => {
    const own = compact(l.brand);
    if (own !== '') return own;
    const t = compact(l.title);
    return brands.find((b) => t.startsWith(b)) ?? compact(l.title.split(/\s+/)[0]);
  };
}

/**
 * A listing's model family: its brand, the model codes it shares with listings of other shops (a code only one shop
 * prints is a part number, often one per colour), and the numbers and model words of its title (identityOf: storage,
 * sizes, model numbers, Pro or Max). Colour words are never part of it.
 */
export function familyKey(l: Listing, brand: string, sharedCodes: string[]): string {
  const id = identityOf(l.title, l.category);
  return [brand, ...sharedCodes, ...id.numbers, ...id.models].join('|');
}

function splitParts(members: Listing[], codesOf: (l: Listing) => string[]): Part[] {
  const out: Part[] = [];
  const brandOf = brandKeyIn(members);
  for (const byBrand of groupBy(members, brandOf)) {
    if (byBrand.length <= MAX_GROUP) {
      out.push({ members: byBrand });
      continue;
    }
    const shopsOf = new Map<string, Set<number>>();
    for (const m of byBrand) for (const c of codesOf(m)) shopsOf.set(c, (shopsOf.get(c) ?? new Set()).add(m.shopId));
    const shared = (m: Listing) => codesOf(m).filter((c) => shopsOf.get(c)!.size >= 2);
    const families = groupBy(byBrand, (m) => familyKey(m, brandOf(m), shared(m)))
      .map((f) => [...f].sort((a, b) => a.id - b.id))
      .sort((a, b) => b.length - a.length || titleOrder(a[0], b[0]));
    const chunks: Listing[][] = [];
    for (const fam of families) {
      if (fam.length > MAX_GROUP) {
        const { parts, leftovers } = familyParts(fam);
        out.push(...parts);
        const sorted = [...leftovers].sort(titleOrder);
        for (let i = 0; i < sorted.length; i += MAX_GROUP) out.push({ members: sorted.slice(i, i + MAX_GROUP) });
        continue;
      }
      let best: Listing[] | null = null;
      let score = FAMILY_AFFINITY;
      for (const c of chunks) {
        if (c.length + fam.length > MAX_GROUP) continue;
        const s = Math.max(...c.map((m) => similarity(fam[0], m)));
        if (s >= score) {
          score = s;
          best = c;
        }
      }
      if (best) best.push(...fam);
      else chunks.push([...fam]);
    }
    for (const c of chunks) out.push({ members: c });
  }
  return out;
}

const colourKey = (l: Listing) => colourWords(l.title).join(' ');

/**
 * Categories where a colour is an option of one product (a phone, a TV, a shoe). Elsewhere it often names another
 * product (a paint, a lipstick shade, card sleeves), so a large family there is cut in title order instead.
 */
const COLOUR_VARIANT_CATEGORIES = new Set(['phones', 'laptops', 'tv-audio', 'appliances', 'home-kitchen', 'fashion', 'sports', 'baby']);

/**
 * A family larger than MAX_GROUP: Claude is shown one listing per shop and colour, or when that is still too many a
 * set covering every shop and every colour, or one listing per shop (in chunks when there are more shops than
 * MAX_GROUP). Every other listing is attached to a shown listing of its shop (one of its colour first) when their
 * titles differ only in colour words and the veto finds no difference; the rest are leftovers, judged as plain
 * listings. Outside COLOUR_VARIANT_CATEGORIES every listing is a leftover.
 */
export function familyParts(fam: Listing[]): { parts: Part[]; leftovers: Listing[] } {
  const sorted = [...fam].sort((a, b) => a.id - b.id);
  if (!COLOUR_VARIANT_CATEGORIES.has(mostCommon(sorted.map((l) => l.category)))) return { parts: [], leftovers: sorted };
  const firstOf = (key: (l: Listing) => string) => groupBy(sorted, key).map((g) => g[0]);
  let reps = firstOf((l) => `${l.shopId}|${colourKey(l)}`);
  if (reps.length > MAX_GROUP) {
    // cover every shop and every colour: listings naming a new shop and a new colour first, then either
    const shops = new Set<number>();
    const colours = new Set<string>();
    const cover: Listing[] = [];
    for (const both of [true, false]) {
      for (const l of sorted) {
        if (cover.includes(l)) continue;
        const newShop = !shops.has(l.shopId);
        const newColour = !colours.has(colourKey(l));
        if (both ? newShop && newColour : newShop || newColour) {
          cover.push(l);
          shops.add(l.shopId);
          colours.add(colourKey(l));
        }
      }
    }
    reps = cover.sort((a, b) => a.id - b.id);
  }
  if (reps.length > MAX_GROUP) reps = firstOf((l) => String(l.shopId));
  const repSet = new Set(reps);
  const attached = new Map<Listing, Listing[]>(reps.map((r) => [r, []]));
  const leftovers: Listing[] = [];
  for (const l of sorted) {
    if (repSet.has(l)) continue;
    const atShop = reps.filter((r) => r.shopId === l.shopId);
    const order = [...atShop.filter((r) => colourKey(r) === colourKey(l)), ...atShop.filter((r) => colourKey(r) !== colourKey(l))];
    const core = withoutColours(l.title);
    const home = order.find((r) => withoutColours(r.title) === core && vetoReasons(vetoListing(r), vetoListing(l)).length === 0);
    if (home) attached.get(home)!.push(l);
    else leftovers.push(l);
  }
  const parts: Part[] = [];
  const n = Math.ceil(reps.length / MAX_GROUP);
  const size = Math.ceil(reps.length / n);
  for (let i = 0; i < reps.length; i += size) {
    const rs = reps.slice(i, i + size);
    const att = rs.map((r) => attached.get(r)!);
    parts.push({ members: [...rs, ...att.flat()], reps: rs, attached: att });
  }
  return { parts, leftovers };
}

/** Every listing already in one barcode or part-number group: nothing to judge. */
function codeMatched(members: Listing[]): boolean {
  if (!members.every((m) => (m.matchMethod === 'gtin' || m.matchMethod === 'mpn') && m.canonicalId)) return false;
  return new Set(members.map((m) => m.canonicalId)).size === 1;
}

function mostCommon(values: string[]): string {
  const n = new Map<string, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
}

/** A part as a candidate group: members sorted by id, the shown listings and their attached ones as indexes. */
export function toCandidate(part: Part, key = candidateKey(part.members)): Candidate {
  const members = [...part.members].sort((a, b) => a.id - b.id);
  const c: Candidate = { key, fingerprint: fingerprint(members), category: mostCommon(members.map((m) => m.category)), members };
  if (part.reps) {
    const at = new Map(members.map((m, i) => [m, i]));
    const order = part.reps.map((r, i) => ({ r: at.get(r)!, att: (part.attached?.[i] ?? []).map((l) => at.get(l)!).sort((a, b) => a - b) })).sort((a, b) => a.r - b.r);
    c.reps = order.map((o) => o.r);
    c.attached = order.map((o) => o.att);
  }
  return c;
}

/** The candidate groups of fresh listings, ordered by key. */
export function buildCandidates(listings: Listing[]): Candidate[] {
  const index = new Map(listings.map((l, i) => [l.id, i]));
  const uf = new UnionFind(listings.length);

  // title-similarity groups (also at one shop: the colours a shop lists on their own)
  for (const members of titleGroups(listings)) {
    const first = members[0];
    for (const m of members.slice(1)) if (compatible(first, m)) uf.union(index.get(first.id)!, index.get(m.id)!);
  }

  // shared model codes
  const codes = listings.map((l) => candidateCodes(l.title));
  const byCode = new Map<string, number[]>();
  codes.forEach((cs, i) => {
    for (const c of cs) {
      const list = byCode.get(c);
      if (list) list.push(i);
      else byCode.set(c, [i]);
    }
  });
  for (const ids of byCode.values()) {
    if (ids.length < 2 || ids.length > MAX_CODE_SHARE) continue;
    ids.forEach((i, n) => {
      for (const j of ids.slice(0, n)) {
        if (compatible(listings[j], listings[i])) {
          uf.union(i, j);
          break;
        }
      }
    });
  }

  const comps = new Map<number, Listing[]>();
  listings.forEach((l, i) => {
    const r = uf.find(i);
    const list = comps.get(r);
    if (list) list.push(l);
    else comps.set(r, [l]);
  });
  const codesOf = (l: Listing) => codes[index.get(l.id)!];
  const out: Candidate[] = [];
  for (const comp of comps.values()) {
    if (comp.length < 2) continue;
    for (const part of splitGroup(comp, codesOf)) {
      // a part Claude would be shown one listing of (one shop's copies of one title) has nothing to judge
      if (part.members.length < 2 || (part.reps && part.reps.length < 2) || codeMatched(part.members)) continue;
      out.push(toCandidate(part));
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

function seededRandom(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  // mulberry32
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A sample of at most n groups taken in turns across categories (each category shuffled with the seed). */
export function spreadSample<T extends { key: string; category: string }>(groups: T[], n: number, seed: string): T[] {
  const byCat = groupBy([...groups].sort((a, b) => (a.key < b.key ? -1 : 1)), (g) => g.category).sort((a, b) => (a[0].category < b[0].category ? -1 : 1));
  const queues = byCat.map((list) => {
    const rand = seededRandom(`${seed}|${list[0].category}`);
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  });
  const out: T[] = [];
  for (let round = 0; out.length < n; round++) {
    let took = false;
    for (const q of queues) {
      if (round < q.length && out.length < n) {
        out.push(q[round]);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}
