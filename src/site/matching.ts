// Groups "the same product" across shops: same barcode, else same part number, else similar titles.
// The title rule is ported from dashboard/src/page.ts (tokens and sameProduct).
import { cleanGtin } from '../util/normalise.js';

/** brand: the shop's brand field when it has one; two rows with different brands are never title-matched */
export type MatchInput = { id: number; shopId: number; gtin: string | null; mpn: string | null; title: string; brand?: string | null };
export type MatchMethod = 'gtin' | 'mpn' | 'title';
export type Match = { key: string; method: MatchMethod };

// Colours and filler words are ignored when comparing titles.
const IGNORE = new Set(
  ('black white silver grey gray blue red green pink purple gold yellow orange beige brown navy titanium natural desert dessert ' +
    'midnight starlight graphite space sage mist lavender cream rose violet teal mint coral obsidian porcelain ' +
    'smartphone phone mobile storage with and the for new edition version dual sim unlocked eu uk ver colour color').split(' '),
);
// Model words must agree between two titles.
const MODEL = new Set('pro max plus mini ultra air lite se fe neo slim xl xs'.split(' '));

/** Titles are cut to this many characters before tokenising, so a huge shop title cannot blow up the work. */
const MAX_TITLE_CHARS = 300;

export function titleTokens(title: string): string[] {
  return (title || '').slice(0, MAX_TITLE_CHARS).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !IGNORE.has(w));
}

const hasDigit = (w: string) => /[0-9]/.test(w);

export function sameTitle(a: string[], b: string[]): boolean {
  const da = a.filter(hasDigit);
  const db = b.filter(hasDigit);
  const [small, big] = da.length <= db.length ? [da, db] : [db, da];
  const bigSet = new Set(big);
  if (!small.every((w) => bigSet.has(w))) return false;
  const ma = a.filter((w) => MODEL.has(w)).sort().join(' ');
  const mb = b.filter((w) => MODEL.has(w)).sort().join(' ');
  if (ma !== mb) return false;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.5;
}

/** A valid GS1 code (check digit verified), zero-padded to 14 digits so UPC, EAN-13 and GTIN-14 forms agree. */
function gtinKey(gtin: string | null): string | null {
  const g = cleanGtin(gtin);
  return g === null ? null : g.padStart(14, '0');
}

/** Values shops put in the MPN field when there is no part number. */
const PLACEHOLDER_MPNS = new Set(['none', 'na', 'default', 'notapplicable', 'tbc', 'tba', 'unknown']);

function mpnKey(mpn: string | null): string | null {
  if (!mpn) return null;
  const n = mpn.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (PLACEHOLDER_MPNS.has(n)) return null;
  // all zeros, or one character repeated ("0000000", "xxxxx")
  if (/^(.)\1*$/.test(n)) return null;
  return n.length >= 5 ? n : null;
}

function distinctShops(items: MatchInput[]): boolean {
  for (let i = 1; i < items.length; i++) if (items[i].shopId !== items[0].shopId) return true;
  return false;
}

function groupByKey(items: MatchInput[], keyOf: (it: MatchInput) => string | null): Map<string, MatchInput[]> {
  const groups = new Map<string, MatchInput[]>();
  for (const it of items) {
    const key = keyOf(it);
    if (key === null) continue;
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }
  return groups;
}

function matchByGtin(items: MatchInput[], out: Map<number, Match>): void {
  for (const [key, members] of groupByKey(items, (it) => gtinKey(it.gtin))) {
    if (!distinctShops(members)) continue;
    for (const m of members) out.set(m.id, { key: `gtin:${key}`, method: 'gtin' });
  }
}

/**
 * Same part number. As a sanity check, an item only counts when it shares at least one non-numeric title word
 * (brand or model name) with an item of another shop in the same group.
 */
function matchByMpn(items: MatchInput[], out: Map<number, Match>): void {
  for (const [key, members] of groupByKey(items, (it) => mpnKey(it.mpn))) {
    if (!distinctShops(members)) continue;
    const words = members.map((m) => new Set(titleTokens(m.title).filter((w) => !hasDigit(w))));
    const shopsByWord = new Map<string, Set<number>>();
    members.forEach((m, i) => {
      for (const w of words[i]) {
        const s = shopsByWord.get(w);
        if (s) s.add(m.shopId);
        else shopsByWord.set(w, new Set([m.shopId]));
      }
    });
    members.forEach((m, i) => {
      for (const w of words[i]) {
        const s = shopsByWord.get(w)!;
        if (s.size > 1) {
          out.set(m.id, { key: `mpn:${key}`, method: 'mpn' });
          return;
        }
      }
    });
  }
}

/** The brand compared case-insensitively, or null when the row has none. */
function brandKey(it: MatchInput): string | null {
  const b = (it.brand ?? '').trim().toLowerCase();
  return b === '' ? null : b;
}

/** A numeric token present in more than this share of items (and at least TITLE_MIN_COMMON items) is too common to probe with. */
const TITLE_COMMON_SHARE = 0.02;
const TITLE_MIN_COMMON = 50;
/** Probe with this many of an item's rarest numeric tokens. */
const TITLE_PROBE_TOKENS = 2;
/** Candidate groups compared per item. */
const TITLE_MAX_CANDIDATES = 200;
/** A group is indexed under at most this many of its rarest numeric tokens. */
const TITLE_MAX_INDEX_KEYS = 8;

/**
 * Greedy grouping against each group's first item. Numeric tokens shared by many items (storage sizes,
 * generation numbers) are not used to find candidates; an item is probed only through its rarest numeric tokens,
 * so the cost stays near linear. Items with only common numeric tokens are not title-matched. An item with a brand
 * never joins a group that already holds a different brand (an Acer and a Lenovo with the same specs differ).
 */
function matchByTitle(items: MatchInput[], out: Map<number, Match>): void {
  type Group = { first: MatchInput; tokens: string[]; members: MatchInput[]; brand: string | null };

  const tokenised = items.map((it) => titleTokens(it.title));
  const freq = new Map<string, number>();
  for (const tokens of tokenised) {
    for (const n of new Set(tokens.filter(hasDigit))) freq.set(n, (freq.get(n) ?? 0) + 1);
  }
  const commonAbove = Math.max(items.length * TITLE_COMMON_SHARE, TITLE_MIN_COMMON);

  const byNumber = new Map<string, Group[]>();
  const groups: Group[] = [];

  items.forEach((it, i) => {
    const tokens = tokenised[i];
    const brand = brandKey(it);
    const keys = [...new Set(tokens.filter(hasDigit))]
      .filter((n) => freq.get(n)! <= commonAbove)
      .sort((a, b) => freq.get(a)! - freq.get(b)!);
    if (keys.length === 0) return;

    let home: Group | undefined;
    let examined = 0;
    const seen = new Set<Group>();
    probe: for (const n of keys.slice(0, TITLE_PROBE_TOKENS)) {
      for (const g of byNumber.get(n) ?? []) {
        if (seen.has(g)) continue;
        seen.add(g);
        if ((brand === null || g.brand === null || g.brand === brand) && sameTitle(g.tokens, tokens)) {
          home = g;
          break probe;
        }
        if (++examined >= TITLE_MAX_CANDIDATES) break probe;
      }
    }
    if (home) {
      home.members.push(it);
      home.brand ??= brand;
      return;
    }
    const g: Group = { first: it, tokens, members: [it], brand };
    groups.push(g);
    for (const n of keys.slice(0, TITLE_MAX_INDEX_KEYS)) {
      const list = byNumber.get(n);
      if (list) list.push(g);
      else byNumber.set(n, [g]);
    }
  });

  for (const g of groups) {
    if (!distinctShops(g.members)) continue;
    for (const m of g.members) out.set(m.id, { key: `title:${g.first.id}`, method: 'title' });
  }
}

/**
 * For every item that matches an item from another shop, returns its group key and how it was matched.
 * GTIN groups first, then MPN, then title; an item grouped by a stronger method is not regrouped.
 */
export function assignMatches(items: MatchInput[]): Map<number, Match> {
  const out = new Map<number, Match>();
  matchByGtin(items, out);
  let rest = items.filter((it) => !out.has(it.id));
  matchByMpn(rest, out);
  rest = rest.filter((it) => !out.has(it.id));
  matchByTitle(rest, out);
  return out;
}
