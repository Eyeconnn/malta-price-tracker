// Groups "the same product" across shops: same barcode, else same part number, else the same canonical name
// (design "Update 23 Oct: match by canonical normalised names"), else similar titles. The title rule is ported from
// dashboard/src/page.ts (tokens and sameProduct).
import { bundleWords, canonText, gpuMemory, PRICE_INCLUDES } from '../names/canon-text.js';
import { conditions, moneyValues, prep } from '../names/text.js';
import { cleanGtin } from '../util/normalise.js';
import { colourWordsIn, withoutColourWords } from '../names/colours.js';
import { nameTokens } from './identity.js';

/**
 * A listing's checked canonical name (product_names.canonical_name) and the category it was made for: names match
 * within one category. guard: the distinguishing words of the shop's title (guardOf), a second check.
 */
export type NameMatch = { canonical: string; category: string; guard: string };

/**
 * brand: the shop's brand field when it has one; two rows with different brands are never title-matched.
 * name: the accepted clean name, when the row has one (name matching).
 */
export type MatchInput = { id: number; shopId: number; gtin: string | null; mpn: string | null; title: string; brand?: string | null; name?: NameMatch | null };
export type MatchMethod = 'gtin' | 'mpn' | 'judged' | 'name' | 'title';
export type Match = { key: string; method: MatchMethod };

// Colours and filler words are ignored when comparing titles.
const IGNORE = new Set(
  ('black white silver grey gray blue red green pink purple gold yellow orange beige brown navy titanium natural desert dessert ' +
    'midnight starlight graphite space sage mist lavender cream rose violet teal mint coral obsidian porcelain ' +
    'smartphone phone mobile storage with and the for new edition version dual sim unlocked eu uk ver colour color').split(' '),
);
// Model words must agree between two titles (also kept by the name normaliser, src/names/check.ts).
export const MODEL = new Set('pro max plus mini ultra air lite se fe neo slim xl xs'.split(' '));

/**
 * Two listings at one shop whose titles name different colours and are otherwise the same words (colour words and
 * the colour modifier before each left out, src/names/colours.ts: Deep Blue, Cosmic Orange; any other word, such as
 * Edge, Classic, Fold, eSIM, Left or Titanium, must be the same): colour options the shop lists on their own.
 */
export function colourSiblings(x: { shopId?: number; title: string }, y: { shopId?: number; title: string }): boolean {
  if (x.shopId === undefined || x.shopId !== y.shopId) return false;
  const split = (t: string) => (t || '').slice(0, MAX_TITLE_CHARS).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w !== '');
  const a = split(x.title);
  const b = split(y.title);
  const ca = colourWordsIn(a).join(' ');
  const cb = colourWordsIn(b).join(' ');
  return ca !== '' && cb !== '' && ca !== cb && withoutColourWords(a).join(' ') === withoutColourWords(b).join(' ');
}

/**
 * Two part numbers of one stem, as a maker numbers the colours of one model (MG8M4 and MG8N4, MFYP4 and MFYM4,
 * SM-S931BZKD and SM-S931BLBD): the same length, the same first 3 characters, and at most a third of the characters
 * (at least 2) different.
 */
export function sameStemParts(a: string | null, b: string | null): boolean {
  if (a === null || b === null || a.length !== b.length || a.slice(0, 3) !== b.slice(0, 3)) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff <= Math.max(2, Math.floor(a.length / 3));
}

/**
 * Two listings whose different part numbers do not make them two products: colour siblings at one shop
 * (colourSiblings) whose part numbers share their stem (sameStemParts). Used by the judge's veto and judged matching.
 */
export function colourPartNumbers(x: { shopId?: number; title: string; mpn?: string | null }, y: { shopId?: number; title: string; mpn?: string | null }): boolean {
  return colourSiblings(x, y) && sameStemParts(mpnIdentity(x.mpn), mpnIdentity(y.mpn));
}

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

/** Colour abbreviations at the end of a model code or part number (T500WHT and T500BLK are one product in two colours). */
export const COLOUR_SUFFIX = /(\d)(?:wht|wh|blk|bk|blu|bl|red|rd|grn|gn|gry|gy|slv|sv|sil|pnk|pk|pur|ppl|gld|gd|brn|bei|nvy|org|ylw|yel)$/;

/** A part number in one spelling with its colour suffix removed, or null when it is no usable part number. */
export function mpnIdentity(mpn: string | null | undefined): string | null {
  const k = mpnKey(mpn ?? null);
  return k === null ? null : k.replace(COLOUR_SUFFIX, '$1');
}

/** A valid barcode (GS1 check digit) as 14 digits, or null. */
export function gtinIdentity(gtin: string | null | undefined): string | null {
  return gtinKey(gtin ?? null);
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
 * Whether the name rule keeps `it` apart from a member of a title group: both have canonical names and they differ
 * (a pack of 6 and a pack of 12), or their condition, money or audience differ, so the title rule must not call them
 * possibly the same either.
 */
function nameConflict(members: MatchInput[], it: MatchInput): boolean {
  const n = it.name;
  if (!n) return false;
  return members.some((m) => m.name && (m.name.canonical !== n.canonical || m.name.category !== n.category || m.name.guard !== n.guard));
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
 * Returns every group of two or more items, also those at one shop (the judge's candidates read them too).
 */
export function titleGroups<T extends MatchInput>(items: T[]): T[][] {
  type Group = { first: T; tokens: string[]; members: T[]; brand: string | null };

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

  return groups.filter((g) => g.members.length >= 2).map((g) => g.members);
}

/** Title groups with listings of two or more shops: possibly the same product (method title, never trusted). */
function matchByTitle(items: MatchInput[], out: Map<number, Match>): void {
  for (const members of titleGroups(items)) {
    if (!distinctShops(members)) continue;
    for (const m of members) out.set(m.id, { key: `title:${members[0].id}`, method: 'title' });
  }
}

/**
 * The name rule's view of a listing: its checked canonical name (src/names/canonical.ts) and category, and a second
 * guard read from the shop's own title (never from Claude's fields): condition, values with a currency, and the
 * gender, children's audience, platform, fragrance concentration, edition, format, bundle and pack words it names,
 * and the GPU memory it states (guardOf). Listings whose guards differ are never one product. Null without a
 * canonical name: such a listing never name-matches.
 */
export function nameMatch(
  canonical: string | null,
  category: string | null,
  texts: { title?: string; displayName?: string | null; variantLabel?: string | null; variantTitles?: string[] } = {},
): NameMatch | null {
  if (!canonical || canonical.trim() === '') return null;
  return { canonical: canonical.trim(), category: category ?? '', guard: guardOf(texts.title ?? '', category ?? '', texts.variantTitles ?? []) };
}

/** Each guard word class: the words it reads (a title token) and the one spelling each counts as. */
const GUARD: Record<string, Record<string, string>> = {
  gender: { men: 'men', mens: 'men', man: 'men', homme: 'men', women: 'women', womens: 'women', woman: 'women', ladies: 'women', femme: 'women', unisex: 'unisex' },
  audience: {
    kids: 'kids', kid: 'kids', children: 'kids', child: 'kids', childrens: 'kids', junior: 'junior', jr: 'junior', boys: 'boys', boy: 'boys', girls: 'girls',
    girl: 'girls', toddler: 'toddler', toddlers: 'toddler', youth: 'youth', baby: 'baby', gs: 'gs', ps: 'ps', td: 'td',
  },
  platform: { switch: 'switch', xbox: 'xbox', xboxone: 'xboxone', seriesx: 'seriesx', seriess: 'seriess', ps4: 'ps4', ps5: 'ps5', pc: 'pc', playstation: 'playstation' },
  concentration: { edt: 'edt', edp: 'edp', edc: 'edc', parfum: 'parfum', cologne: 'edc', elixir: 'elixir', extrait: 'extrait' },
  edition: { ultimate: 'ultimate', premium: 'premium', deluxe: 'deluxe', dayone: 'dayone', collector: 'collector', collectors: 'collector', signature: 'signature', limited: 'limited', goty: 'goty' },
  format: { hardback: 'hardback', hardcover: 'hardback', paperback: 'paperback', digital: 'digital', disc: 'disc', kindle: 'kindle' },
  pack: { monthly: 'monthly', box: 'box', jumbo: 'jumbo', mega: 'mega', value: 'value', bulk: 'bulk', multipack: 'multipack' },
  // the form of a medicine or supplement: 24 tablets and 24 capsules are two products (the name check reads both as filler)
  form: {
    tablet: 'tablet', tablets: 'tablet', caplet: 'tablet', caplets: 'tablet', capsule: 'capsule', capsules: 'capsule', softgel: 'softgel',
    softgels: 'softgel', sachet: 'sachet', sachets: 'sachet', gummy: 'gummy', gummies: 'gummy', effervescent: 'effervescent', syrup: 'syrup',
  },
};
/** Edition words that are colours or plain words elsewhere: only games read them (FC 25 Gold, DualSense Edge). */
const GAME_EDITION: Record<string, string> = { gold: 'gold', standard: 'standard', edge: 'edge' };

/** The second guard of a title (see nameMatch), as one string. */
export function guardOf(title: string, category: string, variantTitles: string[] = []): string {
  const plain = canonText(title)
    .replace(/\bxbox\s+one\b/g, ' xboxone ')
    .replace(/\bseries\s+([xs])\b/g, ' series$1 ')
    .replace(/\bday\s+one\b/g, ' dayone ')
    .replace(/\bgame\s+of\s+the\s+year\b/g, ' goty ');
  const toks = nameTokens(plain);
  const words = (map: Record<string, string>) => [...new Set(toks.flatMap((t) => (Object.hasOwn(map, t) ? [map[t]] : [])))].sort().join(',');
  const edition = [words(GUARD.edition), category === 'gaming' ? words(GAME_EDITION) : ''].filter((x) => x !== '').join(',');
  // a bundle: "&", "and", "with <item>", or bundleWords (+ item spaced or not, w/, incl., includes; Copilot+ PC and
  // Pro+ are labels, incl. VAT is a price)
  const bundle = /&|\band\b|\bwith\s+[\p{L}\p{N}]/u.test(plain.replace(PRICE_INCLUDES, ' ')) || bundleWords(plain) ? 'bundle' : '';
  // the Windows edition: Windows 11 Home and Pro are two laptops (the name check reads the OS family from os)
  const osEdition = [...prep(title).matchAll(/\bw(?:in(?:dows)?)?\s*(?:7|8|10|11)\s*(home|pro|h|p|s)?\b/g)].map((m) => ({ h: 'home', p: 'pro' })[m[1] as 'h' | 'p'] ?? m[1] ?? 'windows');
  // conditions of the title and of every variant title (a group whose variants are refurbished is refurbished)
  const conds = [...new Set([title, ...variantTitles].flatMap((t) => conditions(t)))].sort();
  return [
    conds.join(',') || 'new',
    moneyValues(title).join(',') || 'none',
    words(GUARD.gender),
    words(GUARD.audience),
    words(GUARD.platform),
    words(GUARD.concentration),
    edition,
    words(GUARD.format),
    bundle,
    words(GUARD.pack),
    gpuMemory(prep(title)).join(','),
    [...new Set(osEdition)].sort().join(','),
    words(GUARD.form),
  ].join('|');
}

/** A canonical name shared by more listings than this is too generic to trust ("giftcard"): left alone. */
const NAME_BUCKET_MAX = 200;

type Named = MatchInput & { name: NameMatch };

/** Listings that may form a name group: two or more, at one shop (each colour on its own) or more. */
const groupable = (members: MatchInput[]) => members.length >= 2;

/**
 * Name matching (design "Update 23 Oct"): listings whose canonical names are exactly equal within one category,
 * and whose shop texts agree on condition, money and audience (the second guard), are one product.
 *
 * With GTIN and MPN groups (they keep priority, decided before this runs):
 * - a set of equal listings without a code-matched member is a name group;
 * - a set holding members of exactly one code group, where every named member of that code group is in the set,
 *   adds its other listings to that code group with method 'name';
 * - otherwise code groups are never merged, and only the set's listings without a code match may form a name group.
 */
function matchByName(items: MatchInput[], out: Map<number, Match>): void {
  const keyOf = (it: Named) => `${it.name.category}|${it.name.canonical}|${it.name.guard}`;
  const buckets = groupByKey(
    items.filter((it): it is Named => !!it.name),
    (it) => keyOf(it as Named),
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

  for (const cluster of buckets.values()) {
    if (cluster.length < 2 || cluster.length > NAME_BUCKET_MAX) continue;
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

/**
 * Judged matching (design "Update 23 Oct, afternoon"): each cluster lists site_products ids Claude judged exactly the
 * same product, whose judgement fingerprint is current and which the veto in code did not overrule (src/match/apply.ts).
 * With GTIN and MPN groups (they keep priority, decided before this runs), as for name groups:
 * - a cluster without a code-matched member is a judged group (also listings of one shop: its colours);
 * - a cluster holding members of exactly one code group, where every judged member of that code group is in the
 *   cluster, adds its other listings to that code group with method 'judged';
 * - otherwise code groups are never merged, and only the cluster's listings without a code match may form a group.
 */
function matchByJudged(items: MatchInput[], clusters: number[][], out: Map<number, Match>): void {
  const byId = new Map(items.map((it) => [it.id, it]));
  // two valid barcodes at two shops, or two part numbers, are two products whatever the judgement says (review C3);
  // the colours one shop lists on their own may each have their own part number of one stem (colourPartNumbers)
  const conflict = (x: MatchInput, y: MatchInput) => {
    const gx = gtinKey(x.gtin);
    const gy = gtinKey(y.gtin);
    if (gx !== null && gy !== null && gx !== gy && x.shopId !== y.shopId) return true;
    const px = mpnIdentity(x.mpn);
    const py = mpnIdentity(y.mpn);
    return px !== null && py !== null && px !== py && !colourPartNumbers(x, y);
  };
  const lists: number[][] = [];
  /** clusters the barcodes split: their free listings join no code group (which part they belong to is unknown) */
  const split = new Set<number[]>();
  for (const c of clusters) {
    const parts: number[][] = [];
    for (const id of [...new Set(c)].filter((i) => byId.has(i)).sort((x, y) => x - y)) {
      const home = parts.find((p) => p.every((o) => !conflict(byId.get(o)!, byId.get(id)!)));
      if (home) home.push(id);
      else parts.push([id]);
    }
    for (const p of parts) {
      if (p.length < 2) continue;
      lists.push(p);
      if (parts.length > 1) split.add(p);
    }
  }
  // the listings of each code group, to check a joining listing against every one of them (review G4, G5)
  const membersOf = new Map<string, MatchInput[]>();
  for (const [id, m] of out) {
    const it = byId.get(id);
    if (!it) continue;
    const list = membersOf.get(m.key);
    if (list) list.push(it);
    else membersOf.set(m.key, [it]);
  }
  /** A listing never joins a code group whose barcode or part number differs from its own or a member's. */
  const fits = (id: number, code: string) => {
    const it = byId.get(id)!;
    if (code.startsWith('gtin:')) {
      const g = gtinKey(it.gtin);
      if (g !== null && `gtin:${g}` !== code) return false;
    }
    if (code.startsWith('mpn:')) {
      const p = mpnKey(it.mpn);
      if (p !== null && `mpn:${p}` !== code) return false;
    }
    return (membersOf.get(code) ?? []).every((m) => !conflict(m, it) && !conflictSameShop(m, it));
  };
  /** Two barcodes or part numbers that differ, also at one shop (a code group holds one product). */
  const conflictSameShop = (x: MatchInput, y: MatchInput) => {
    const gx = gtinKey(x.gtin);
    const gy = gtinKey(y.gtin);
    return gx !== null && gy !== null && gx !== gy;
  };
  /**
   * A new judged group: listings of two or more shops, or the colour or size variants one shop lists on their own
   * (titles that differ only in colour or size words); a group of one shop's listings is otherwise no product of
   * several sellers (review G7).
   */
  const assignNew = (ids: number[], key: string) => {
    if (new Set(ids.map((id) => byId.get(id)!.shopId)).size > 1 || variantsOfOne(ids.map((id) => byId.get(id)!))) assign(ids, key);
  };
  const judgedOfCode = new Map<string, Set<number>>();
  for (const c of lists) {
    for (const id of c) {
      const code = out.get(id)?.key;
      if (code === undefined) continue;
      const set = judgedOfCode.get(code) ?? new Set<number>();
      set.add(id);
      judgedOfCode.set(code, set);
    }
  }
  const assign = (ids: number[], key: string) => {
    for (const id of ids) out.set(id, { key, method: 'judged' });
  };
  for (const c of lists) {
    const free = c.filter((id) => !out.has(id));
    if (free.length === 0) continue;
    const codes = new Set(c.filter((id) => out.has(id)).map((id) => out.get(id)!.key));
    if (codes.size === 0) {
      assignNew(free, `judged:${Math.min(...c)}`);
      continue;
    }
    if (codes.size === 1 && !split.has(c)) {
      const code = [...codes][0];
      const ids = new Set(c);
      if ([...judgedOfCode.get(code)!].every((id) => ids.has(id))) {
        assign(free.filter((id) => fits(id, code)), code);
        continue;
      }
    }
    if (free.length >= 2) assignNew(free, `judged:${Math.min(...free)}`);
  }
}

/** Size words of clothing and shoes (one product in several sizes). */
const SIZE_TOKENS = new Set('xs xl xxl xxxl 2xl 3xl 4xl small medium large size'.split(' '));

/** Whether listings are colour or size variants of one product: different titles, the same words besides colour and size. */
function variantsOfOne(items: MatchInput[]): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const core = (t: string) =>
    titleTokens(t.replace(/\b(?:size|eu|uk|us)\s*\d+(?:\.\d+)?\b/gi, ' ')).filter((w) => !SIZE_TOKENS.has(w)).sort().join(' ');
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (norm(items[i].title) === norm(items[j].title) || core(items[i].title) !== core(items[j].title)) return false;
    }
  }
  return true;
}

/**
 * For every item that matches an item from another shop, returns its group key and how it was matched.
 * GTIN groups first, then MPN, then the judged clusters (opts.judged), then the clean name, then title; an item
 * grouped by a stronger method is not regrouped (the judged and name rules may add listings to a GTIN or MPN group,
 * see matchByJudged and matchByName).
 */
export function assignMatches(items: MatchInput[], opts: { judged?: number[][] } = {}): Map<number, Match> {
  const out = new Map<number, Match>();
  matchByGtin(items, out);
  let rest = items.filter((it) => !out.has(it.id));
  matchByMpn(rest, out);
  if (opts.judged && opts.judged.length > 0) matchByJudged(items, opts.judged, out);
  matchByName(items, out);
  rest = items.filter((it) => !out.has(it.id));
  matchByTitle(rest, out);
  return out;
}
