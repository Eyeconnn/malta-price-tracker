// Candidate groups for pnpm judge-matches (design "Update 23 Oct, afternoon", point 1): listings at different shops
// (and colour or size listings at one shop) that are likely the same product. They come from the title-similarity
// groups of src/site/matching.ts and from model codes shared by listings of the same or a neighbouring category,
// never across two brands. A group has at most MAX_GROUP listings: larger ones are split by brand, then by model
// code, then by title order. Groups whose every listing is already matched by one barcode or part number are left
// out. Pure: src/match/load.ts reads the listings.
import { createHash } from 'node:crypto';
import { canonText } from '../names/canon-text.js';
import { titleGroups } from '../site/matching.js';
import { candidateKey, fingerprint } from './fingerprint.js';
import { modelCodes, sameOrNeighbour } from './veto.js';

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

export type Candidate = { key: string; fingerprint: string; category: string; members: Listing[] };

export const MAX_GROUP = 12;
/** Candidate model codes are at least this long (s24 alone links every S24 case). */
const MIN_CODE = 4;
/** A code shared by more listings than this is a family or chip name, not one product. */
const MAX_CODE_SHARE = 40;

/** Model codes (src/match/veto.ts) of 4 or more characters, and set or article numbers of 5 to 8 digits. */
export function candidateCodes(title: string): string[] {
  const out = new Set(modelCodes(title).filter((c) => c.length >= MIN_CODE));
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

/** Splits a group larger than MAX_GROUP by brand, then by its most shared model code, then into chunks by title. */
function split(members: Listing[], codesOf: (l: Listing) => string[]): Listing[][] {
  if (members.length <= MAX_GROUP) return [members];
  const out: Listing[][] = [];
  for (const byBrand of groupBy(members, (m) => compact(m.brand) || compact(m.title.split(/\s+/)[0]))) {
    if (byBrand.length <= MAX_GROUP) {
      out.push(byBrand);
      continue;
    }
    const count = new Map<string, number>();
    for (const m of byBrand) for (const c of codesOf(m)) count.set(c, (count.get(c) ?? 0) + 1);
    const main = (m: Listing) => [...codesOf(m)].sort((a, b) => count.get(b)! - count.get(a)! || (a < b ? -1 : 1))[0] ?? '';
    for (const byCode of groupBy(byBrand, main)) {
      if (byCode.length <= MAX_GROUP) {
        out.push(byCode);
        continue;
      }
      const sorted = [...byCode].sort(titleOrder);
      const parts = Math.ceil(sorted.length / MAX_GROUP);
      const size = Math.ceil(sorted.length / parts);
      for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
    }
  }
  return out;
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
    for (const part of split(comp, codesOf)) {
      if (part.length < 2 || codeMatched(part)) continue;
      const members = [...part].sort((a, b) => a.id - b.id);
      out.push({ key: candidateKey(members), fingerprint: fingerprint(members), category: mostCommon(members.map((m) => m.category)), members });
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
