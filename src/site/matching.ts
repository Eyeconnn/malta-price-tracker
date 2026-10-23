// Groups "the same product" across shops: same barcode, else same part number, else the same clean name and key
// specs (design Part 3, "name + specs"), else similar titles. The title rule is ported from dashboard/src/page.ts
// (tokens and sameProduct).
import { hasBrand } from '../names/brand.js';
import { compact } from '../names/text.js';
import { cleanGtin } from '../util/normalise.js';
import { identityValues, nameKey, nameTokens, sameIdentity } from './identity.js';

/**
 * A row's accepted clean name (product_names, status ok) as the name rule reads it. brand: the row's reliable
 * brand in compact form (src/names/brand.ts: reliable or house), null when it has none; brandInName: the clean
 * name contains that brand.
 */
export type NameMatch = { key: string; brand: string | null; brandInName: boolean; identity: Record<string, string> };

/**
 * brand: the shop's brand field when it has one; two rows with different brands are never title-matched.
 * name: the accepted clean name, when the row has one (name matching).
 */
export type MatchInput = { id: number; shopId: number; gtin: string | null; mpn: string | null; title: string; brand?: string | null; name?: NameMatch | null };
export type MatchMethod = 'gtin' | 'mpn' | 'name' | 'title';
export type Match = { key: string; method: MatchMethod };

// Colours and filler words are ignored when comparing titles.
const IGNORE = new Set(
  ('black white silver grey gray blue red green pink purple gold yellow orange beige brown navy titanium natural desert dessert ' +
    'midnight starlight graphite space sage mist lavender cream rose violet teal mint coral obsidian porcelain ' +
    'smartphone phone mobile storage with and the for new edition version dual sim unlocked eu uk ver colour color').split(' '),
);
// Model words must agree between two titles (also kept by the name normaliser, src/names/check.ts).
export const MODEL = new Set('pro max plus mini ultra air lite se fe neo slim xl xs'.split(' '));

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

/**
 * Whether the name rule keeps `it` apart from a member of a title group: both have the same clean name but their
 * brands or identity specs disagree (a pack of 6 and a pack of 12), so the title rule must not call them possibly
 * the same either.
 */
function nameConflict(members: MatchInput[], it: MatchInput): boolean {
  const n = it.name;
  if (!n) return false;
  return members.some((m) => m.name && m.name.key === n.key && !sameNamedProduct(m as Named, it as Named));
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
        if ((brand === null || g.brand === null || g.brand === brand) && sameTitle(g.tokens, tokens) && !nameConflict(g.members, it)) {
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
 * The name rule's view of a clean name: its nameKey, the category's identity specs from its attributes, and the
 * row's reliable brand (null when the brand field is missing, unreliable or a placeholder; judged by the caller).
 * Null when the name has no letters or digits.
 */
export function nameMatch(displayName: string, category: string | null, attrs: Record<string, unknown> | null, reliableBrand: string | null): NameMatch | null {
  const key = nameKey(displayName);
  if (key === '') return null;
  const brand = reliableBrand && compact(reliableBrand) !== '' ? compact(reliableBrand) : null;
  return { key, brand, brandInName: reliableBrand !== null && brand !== null && hasBrand(nameTokens(displayName), reliableBrand), identity: identityValues(category, attrs) };
}

/** A clean name shared by more listings than this is too generic to match by ("Gift Card"): left alone. */
const NAME_BUCKET_MAX = 200;

type Named = MatchInput & { name: NameMatch };

const sameValues = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

/**
 * Listings that may form a name group: two or more shops, or two or more listings of one shop whose identity
 * specs are the same (not only agreeing where both have them: within one shop a missing storage is not a match).
 */
function groupable(members: MatchInput[]): boolean {
  if (distinctShops(members)) return true;
  const named = members as Named[];
  return named.length >= 2 && named.every((m) => sameValues(m.name.identity, named[0].name.identity));
}

/**
 * Same brand (or both none, or one none when the shared name carries the other's brand) and every identity spec
 * both have equal. The names are already equal (same bucket).
 */
function sameNamedProduct(a: Named, b: Named): boolean {
  const ba = a.name.brand;
  const bb = b.name.brand;
  const brandOk = ba === bb || (ba === null && b.name.brandInName) || (bb === null && a.name.brandInName);
  return brandOk && sameIdentity(a.name.identity, b.name.identity);
}

/**
 * Name matching (design Part 3). Listings with an accepted clean name are bucketed by nameKey (no pairwise work
 * across buckets); inside a bucket the most specific listings go first and each listing joins the one cluster it
 * agrees with (brand and identity specs with every member). A listing that agrees with two or more clusters (a
 * phone without storage next to a 256GB and a 512GB one) joins none.
 *
 * With GTIN and MPN groups (they keep priority, decided before this runs):
 * - a cluster without a code-matched member is a name group when it spans two or more shops, or when it is two or
 *   more listings of one shop with exactly the same identity specs (a shop that lists each colour or size as its own
 *   product: colour and size are variant options, so they become one product with those options);
 * - a cluster holding members of exactly one code group, where every named member of that code group is in the
 *   cluster (their names and specs agree), adds its other listings to that code group with method 'name';
 * - otherwise (members of two code groups, or a code group whose named listings disagree) code groups are never
 *   merged, and only the cluster's listings without a code match may form a name group of their own.
 */
function matchByName(items: MatchInput[], out: Map<number, Match>): void {
  const buckets = groupByKey(
    items.filter((it): it is Named => !!it.name && it.name.key !== ''),
    (it) => (it as Named).name.key,
  ) as Map<string, Named[]>;
  // the named members of each code group, to check that all of them agree before a listing joins it
  const namedOfCode = new Map<string, Set<number>>();
  for (const members of buckets.values()) {
    for (const m of members) {
      const code = out.get(m.id)?.key;
      if (code === undefined) continue;
      const set = namedOfCode.get(code) ?? new Set<number>();
      set.add(m.id);
      namedOfCode.set(code, set);
    }
  }

  const assign = (members: MatchInput[], key: string) => {
    for (const m of members) out.set(m.id, { key, method: 'name' });
  };

  for (const members of buckets.values()) {
    if (members.length < 2 || members.length > NAME_BUCKET_MAX) continue;
    const ordered = [...members].sort((a, b) => Object.keys(b.name.identity).length - Object.keys(a.name.identity).length || a.id - b.id);
    const clusters: Named[][] = [];
    for (const it of ordered) {
      const fits = clusters.filter((c) => c.every((m) => sameNamedProduct(m, it)));
      if (fits.length === 1) fits[0].push(it);
      else if (fits.length === 0) clusters.push([it]);
      // agrees with two or more clusters: ambiguous, joins none
    }

    for (const cluster of clusters) {
      const free = cluster.filter((m) => !out.has(m.id));
      if (free.length === 0) continue;
      const codes = new Set(cluster.filter((m) => out.has(m.id)).map((m) => out.get(m.id)!.key));
      if (codes.size === 0) {
        if (groupable(cluster)) assign(free, `name:${Math.min(...cluster.map((m) => m.id))}`);
        continue;
      }
      if (codes.size === 1) {
        const code = [...codes][0];
        const ids = new Set(cluster.map((m) => m.id));
        if ([...namedOfCode.get(code)!].every((id) => ids.has(id))) {
          assign(free, code);
          continue;
        }
      }
      if (groupable(free)) assign(free, `name:${Math.min(...free.map((m) => m.id))}`);
    }
  }
}

/**
 * For every item that matches an item from another shop, returns its group key and how it was matched.
 * GTIN groups first, then MPN, then the clean name, then title; an item grouped by a stronger method is not
 * regrouped (the name rule may add listings to a GTIN or MPN group, see matchByName).
 */
export function assignMatches(items: MatchInput[]): Map<number, Match> {
  const out = new Map<number, Match>();
  matchByGtin(items, out);
  let rest = items.filter((it) => !out.has(it.id));
  matchByMpn(rest, out);
  matchByName(items, out);
  rest = items.filter((it) => !out.has(it.id));
  matchByTitle(rest, out);
  return out;
}
