// Groups "the same product" across shops: same barcode, else same part number, else similar titles.
// The title rule is ported from dashboard/src/page.ts (tokens and sameProduct).

export type MatchInput = { id: number; shopId: number; gtin: string | null; mpn: string | null; title: string };
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

export function titleTokens(title: string): string[] {
  return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !IGNORE.has(w));
}

const hasDigit = (w: string) => /[0-9]/.test(w);

export function sameTitle(a: string[], b: string[]): boolean {
  const da = a.filter(hasDigit);
  const db = b.filter(hasDigit);
  const [small, big] = da.length <= db.length ? [da, db] : [db, da];
  if (!small.every((w) => big.includes(w))) return false;
  const ma = a.filter((w) => MODEL.has(w)).sort().join(' ');
  const mb = b.filter((w) => MODEL.has(w)).sort().join(' ');
  if (ma !== mb) return false;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.5;
}

/** Digits only, leading zeros removed so UPC-A and EAN-13 forms of one code agree. Null when not a plausible GTIN. */
function normaliseGtin(gtin: string | null): string | null {
  if (!gtin) return null;
  const digits = gtin.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 14) return null;
  const stripped = digits.replace(/^0+/, '');
  return stripped === '' ? null : stripped;
}

function normaliseMpn(mpn: string | null): string | null {
  if (!mpn) return null;
  const n = mpn.toLowerCase().replace(/[^a-z0-9]/g, '');
  return n.length >= 5 ? n : null;
}

function distinctShops(items: MatchInput[]): boolean {
  for (let i = 1; i < items.length; i++) if (items[i].shopId !== items[0].shopId) return true;
  return false;
}

/** Groups by an exact key; every member of a group that spans at least two shops is matched. */
function matchByKey(
  items: MatchInput[],
  keyOf: (it: MatchInput) => string | null,
  method: MatchMethod,
  out: Map<number, Match>,
): void {
  const groups = new Map<string, MatchInput[]>();
  for (const it of items) {
    const key = keyOf(it);
    if (key === null) continue;
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }
  for (const [key, members] of groups) {
    if (!distinctShops(members)) continue;
    for (const m of members) out.set(m.id, { key: `${method}:${key}`, method });
  }
}

/** Greedy grouping against each group's first item, using a numeric-token index so only plausible candidates are compared. */
function matchByTitle(items: MatchInput[], out: Map<number, Match>): void {
  type Group = { first: MatchInput; tokens: string[]; members: MatchInput[] };
  const byNumber = new Map<string, Group[]>();
  const groups: Group[] = [];

  for (const it of items) {
    const tokens = titleTokens(it.title);
    const numbers = [...new Set(tokens.filter(hasDigit))];
    if (numbers.length === 0) continue;

    const candidates = new Set<Group>();
    for (const n of numbers) for (const g of byNumber.get(n) ?? []) candidates.add(g);

    let home: Group | undefined;
    for (const g of candidates) {
      if (sameTitle(g.tokens, tokens)) {
        home = g;
        break;
      }
    }
    if (home) {
      home.members.push(it);
      continue;
    }
    const g: Group = { first: it, tokens, members: [it] };
    groups.push(g);
    for (const n of numbers) {
      const list = byNumber.get(n);
      if (list) list.push(g);
      else byNumber.set(n, [g]);
    }
  }

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
  matchByKey(items, (it) => normaliseGtin(it.gtin), 'gtin', out);
  let rest = items.filter((it) => !out.has(it.id));
  matchByKey(rest, (it) => normaliseMpn(it.mpn), 'mpn', out);
  rest = rest.filter((it) => !out.has(it.id));
  matchByTitle(rest, out);
  return out;
}
