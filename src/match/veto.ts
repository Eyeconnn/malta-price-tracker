// The veto in code (design "Update 23 Oct, afternoon: Claude judges candidate groups side by side", point 3). When
// Claude says listings are the same product, the code overrules it whenever their titles or data disagree on a
// number with a unit, a model code (colour suffixes stripped), a bare model number, model words (Pro, Plus, Ultra),
// condition, money, pack or piece count (variant titles included), audience, gender (also from the shop's category
// path), platform, edition, format, bundle words, OS family, Windows version and edition, storage type, SIM, region
// (plug, version, voltage), material, size words, the variety of a drink, food or toiletry (Light, Zero, Pink,
// Merlot, Cucumber), the brand, or the site category. It reuses the title guard of name matching (guardOf) and the
// text helpers of the name checks. Pure: the judge run and the site build both call it.
import { canonText } from '../names/canon-text.js';
import { conditions, packCounts, prep, quantityClass, QUANTITY, tokens, UNIT } from '../names/text.js';
import { guardOf, MODEL } from '../site/matching.js';

export type VetoListing = {
  title: string;
  variantTitles?: string[];
  brand?: string | null;
  /** site category slug */
  category: string;
  /** the shop's own category path (its gender words count) */
  categoryPath?: string | null;
  gtin?: string | null;
  mpn?: string | null;
};

/** Categories whose listings may be one product although the shops filed them differently (also used for candidates). */
export const NEIGHBOURS: Record<string, string[]> = {
  laptops: ['phones', 'gaming', 'tv-audio', 'other'],
  phones: ['laptops', 'tv-audio', 'gaming', 'other'],
  'tv-audio': ['phones', 'laptops', 'gaming', 'other'],
  gaming: ['laptops', 'phones', 'tv-audio', 'toys', 'other'],
  appliances: ['home-kitchen', 'beauty-health', 'other'],
  'home-kitchen': ['appliances', 'other'],
  toys: ['gaming', 'baby', 'other'],
  baby: ['toys', 'beauty-health', 'other'],
  fashion: ['sports', 'other'],
  sports: ['fashion', 'other'],
  'beauty-health': ['baby', 'appliances', 'other'],
  drinks: ['other'],
  other: ['laptops', 'phones', 'tv-audio', 'gaming', 'appliances', 'home-kitchen', 'toys', 'baby', 'fashion', 'sports', 'beauty-health', 'drinks'],
};

export const sameOrNeighbour = (a: string, b: string) => a === b || (NEIGHBOURS[a] ?? []).includes(b);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The title without the brands of the pair (so "Moet & Chandon" or "Black+Decker" is no bundle and "Red Bull" no variety). */
function withoutBrands(text: string, brands: string[]): string {
  let s = text;
  for (const b of brands) s = s.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(b)}(?=$|[^\\p{L}\\p{N}])`, 'giu'), '$1 ');
  return s
    // Apple Watch "GPS + Cellular" is a model, not a bundle
    .replace(/\bgps\s*\+\s*(cellular|lte)\b/gi, 'gps $1')
    .replace(/\bfree\s+(?:delivery|shipping|postage|gift|returns?)\b/gi, ' ')
    .replace(/\bspecial\s+(?:offer|price|deal|sale)s?\b/gi, ' ')
    .replace(/\b(\d)\s*-?\s*in\s*-?\s*(\d)\b/gi, '$1in$2');
}

/** Colour words (a colour or a marketing colour name next to "titanium" keeps it a colour). */
const COLOURS = new Set(
  ('black white silver grey gray blue red green pink purple gold yellow orange beige brown navy natural desert midnight starlight ' +
    'graphite space sage mist lavender cream rose violet teal mint coral obsidian porcelain jet onyx phantom cobalt icy amber marble ' +
    'silverblue jetblack titaniumblack whitesilver').split(' '),
);

/** Colour abbreviations at the end of a model code (T500WHT and T500BLK are one product in two colours). */
const COLOUR_SUFFIX = /(\d)(?:wht|wh|blk|bk|blu|bl|red|rd|grn|gn|gry|gy|slv|sv|sil|pnk|pk|pur|ppl|gld|gd|brn|bei|nvy|org|ylw|yel)$/;

const isQuantity = (t: string) => {
  const m = QUANTITY.exec(t);
  return m !== null && m[2] !== '' && Object.hasOwn(UNIT, m[2]);
};
const hasLetter = (t: string) => /\p{L}/u.test(t);
const hasDigit = (t: string) => /\d/.test(t);
const isCode = (t: string) => t.length >= 3 && hasLetter(t) && hasDigit(t) && !isQuantity(t);

/**
 * The model codes of a text, lower case, colour suffix stripped: words with letters and digits of at least 3
 * characters that are not a quantity (S24, A15s, Q600C), and dash or slash compounds written together (SM-S921B is
 * also sms921b) unless a part is a quantity or a plain word (256GB-Storage, mini-M4).
 */
export function modelCodes(text: string): string[] {
  const t = canonText(text);
  const out = new Set<string>();
  for (const run of t.match(/[\p{L}\p{N}]+(?:[-/][\p{L}\p{N}]+)*/gu) ?? []) {
    const parts = run.split(/[-/]/);
    for (const p of parts) if (isCode(p)) out.add(p);
    if (parts.length > 1 && !parts.some((p) => isQuantity(p) || (!hasDigit(p) && p.length >= 4))) {
      const joined = parts.join('');
      if (isCode(joined)) out.add(joined);
    }
  }
  return [...new Set([...out].map((c) => c.replace(COLOUR_SUFFIX, '$1')))].filter(isCode).sort();
}

/** A code up to its last digit: a15s and a15 share the stem a15, s921b and s921u the stem s921. */
const stem = (c: string) => c.replace(/\D+$/, '');

const compactText = (s: string) => canonText(s).replace(/[^\p{L}\p{N}]+/gu, '');

/** Codes of `a` that `b` does not have, also not written inside b's text (HW-Q600C in HWQ600C). */
function unexplained(a: string[], b: string[], bText: string): string[] {
  const bs = new Set(b);
  return a.filter((c) => !bs.has(c) && !bText.includes(c));
}

function codeConflict(a: string[], b: string[], aText: string, bText: string): string | null {
  const onlyA = a.filter((c) => !b.includes(c));
  const onlyB = b.filter((c) => !a.includes(c));
  for (const x of onlyA) {
    for (const y of onlyB) {
      if (x !== y && stem(x) === stem(y) && /\d/.test(stem(x))) return `model code ${x} vs ${y}`;
    }
  }
  const ua = unexplained(a, b, bText);
  const ub = unexplained(b, a, aText);
  return ua.length > 0 && ub.length > 0 ? `model code ${ua.join(' ')} vs ${ub.join(' ')}` : null;
}

/** Name tokens of a cleaned text ("+" reads as plus, so Pro+ is Pro Plus). */
const words = (s: string) => tokens(canonText(s).replace(/\+/g, ' plus '));

/** Numbers with a unit per class (gb, ml, g, cm, in, w, v, ...). Pieces and "6x" counts are compared as counts. */
function quantities(texts: string[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const text of texts) {
    for (const t of tokens(prep(text))) {
      const q = quantityClass(t);
      if (!q || q.cls === 'pcs' || q.cls === 'x') continue;
      const s = out.get(q.cls) ?? new Set<number>();
      s.add(q.value);
      out.set(q.cls, s);
    }
  }
  return out;
}

const PIECES = /\b(\d+)\s*-?\s*(?:pcs?|pieces?|pce|pz|pezzi|teile)\b/g;
function pieces(texts: string[]): Set<number> {
  const out = new Set<number>();
  for (const text of texts) for (const m of prep(text).matchAll(PIECES)) out.add(Number(m[1]));
  return out;
}

/** Pack counts of the title and every variant title; a listing that states none is a single item. */
function packs(texts: string[]): Set<number> {
  const out = new Set<number>();
  for (const text of texts) {
    const t = prep(text);
    for (const p of packCounts(text, { pieces: false })) out.add(p.n);
    if (/\b(?:two|2)[\s-]?pack\b|\bduo\b|\bdouble[\s-]?pack\b/.test(t)) out.add(2);
    if (/\bsingle\b(?!\s*(?:malt|origin|serve|sim|bed|duvet|sheet|estate|cream|grain|oven|door|use))/.test(t)) out.add(1);
  }
  if (out.size === 0) out.add(1);
  return out;
}

const NUMBER = /^\d+(?:\.\d+)?$/;

/** Bare numbers of the title (iPhone 15, LEGO 42115, Size 4), not counts, and not clothing or shoe sizes. */
function bareNumbers(title: string, category: string): Set<number> {
  const counted = new Set([...packCounts(title).map((p) => p.n), ...pieces([title])]);
  const toks = words(title);
  const out = new Set<number>();
  toks.forEach((t, i) => {
    if (!NUMBER.test(t)) return;
    const n = Number(t);
    if (counted.has(n)) return;
    if ((category === 'fashion' || category === 'sports') && /^(?:size|eu|uk|us|it|fr)$/.test(toks[i - 1] ?? '')) return;
    out.add(n);
  });
  return out;
}

/** Words that name another model when one listing has them and the other not. */
function modelWords(texts: string[], category: string): Set<string> {
  const out = new Set<string>();
  const clothing = category === 'fashion' || category === 'sports';
  const device = ['phones', 'laptops', 'tv-audio', 'gaming'].includes(category);
  for (const text of texts) {
    // the Windows edition (Windows 11 Pro, W11P) is compared on its own
    const toks = words(prep(text).replace(/\bw(?:in(?:dows)?)?\s*(?:7|8|10|11)\s*(?:home|pro|h|p|s)?\b/g, ' '));
    toks.forEach((t, i) => {
      if (MODEL.has(t) || t === 'oled') {
        if (clothing && (t === 'xl' || t === 'xs')) return;
        if (t === 'air' && !device) return;
        out.add(t);
      }
      // Kenwood Chef Titanium, Tefal Titanium: a product line in appliances and kitchenware, a colour on a phone
      if (t === 'titanium' && (category === 'appliances' || category === 'home-kitchen') && !COLOURS.has(toks[i - 1] ?? '') && !COLOURS.has(toks[i + 1] ?? '')) {
        out.add('titanium');
      }
    });
    if (/\bnew\s+(?:nintendo\s+)?[23]ds\b/.test(prep(text))) out.add('new');
  }
  return out;
}

/** Words that each name one class of thing; two listings naming different ones of a class differ. */
const MATERIAL: Record<string, string> = Object.fromEntries(
  [
    ...'leather suede nubuck canvas mesh knit titanium steel ceramic glass plastic wood wooden bamboo cotton wool merino cashmere silk linen denim nylon polyester fleece carbon silicone rubber granite marble copper brass acrylic velvet satin'.split(' ').map((w) => [w, w]),
    ['aluminum', 'aluminium'], ['aluminium', 'aluminium'], ['alu', 'aluminium'], ['stainless', 'steel'], ['wooden', 'wood'],
  ],
);
const SIZE_WORD: Record<string, string> = {
  small: 'small', medium: 'medium', large: 'large', xxl: 'xxl', giant: 'giant', king: 'king', superking: 'superking', queen: 'queen', double: 'double',
};
const STORAGE_TYPE: Record<string, string> = { ssd: 'ssd', nvme: 'ssd', emmc: 'emmc', hdd: 'hdd', ufs: 'ufs' };

function classWords(texts: string[], map: Record<string, string>): Set<string> {
  const out = new Set<string>();
  for (const text of texts) for (const t of words(text)) if (Object.hasOwn(map, t)) out.add(map[t]);
  return out;
}

/** Categories where a flavour, scent or colour word names another product (Coca-Cola Light, Gordon's Pink Gin). */
const VARIETY_CATEGORIES = new Set(['drinks', 'other', 'beauty-health', 'baby']);
const COLOUR_VARIETY_CATEGORIES = new Set(['drinks', 'other']);
const VARIETY = new Set(
  ('light lite diet zero free max decaf decaffeinated unsweetened sparkling still salted unsalted smoked mild hot spicy sensitive ' +
    'cherry vanilla lemon lime orange mint peppermint spearmint strawberry raspberry mango peach coconut chocolate caramel honey ' +
    'cucumber aloe lavender citrus menthol spiced blackcurrant berry tropical ginger cinnamon ' +
    'merlot pinot grigio noir chardonnay sauvignon cabernet shiraz syrah malbec tempranillo riesling zinfandel moscato prosecco rioja ' +
    'chianti primitivo nero montepulciano blanc brut').split(' '),
);
const VARIETY_COLOURS = new Set('gold pink rose red white black blue green silver amber'.split(' '));

function varieties(texts: string[], category: string): Set<string> {
  const out = new Set<string>();
  if (!VARIETY_CATEGORIES.has(category)) return out;
  for (const text of texts) {
    const t = prep(text);
    for (const m of t.matchAll(/\b(light|medium|dark|blonde)\s+roast\b/g)) out.add(`${m[1]} roast`);
    const plain = t.replace(/\b(?:light|medium|dark|blonde)\s+roast\b/g, ' ');
    for (const w of words(plain)) {
      if (VARIETY.has(w) || (COLOUR_VARIETY_CATEGORIES.has(category) && VARIETY_COLOURS.has(w))) out.add(w);
    }
  }
  return out;
}

/** Regions a title names: plug type and version or stock words. */
function regions(text: string): Set<string> {
  const t = prep(text);
  const out = new Set<string>();
  const NAME: Record<string, string> = { usa: 'us', intl: 'global', international: 'global', cn: 'china', jp: 'japan' };
  for (const m of t.matchAll(/\b(eu|uk|us|usa|au|global|international|intl|asia|china|cn|hk|japan|jp|in)\s*[-/]?\s*(?:plug|version|ver|model|spec|stock|import)\b/g)) out.add(NAME[m[1]] ?? m[1]);
  if (/\b3[\s-]?pin\b/.test(t)) out.add('uk');
  if (/\bschuko\b/.test(t)) out.add('eu');
  return out;
}

const SIM: [string, RegExp][] = [
  ['dual sim', /\bdual[\s-]?sim\b|\bds\b/],
  ['esim', /\be[\s-]?sim\b/],
  ['single sim', /\bsingle[\s-]?sim\b/],
];
function sims(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) for (const [k, re] of SIM) if (re.test(prep(text))) out.add(k);
  return out;
}

const OS: [string, RegExp][] = [
  ['windows', /\bw(?:in(?:dows)?)?\s*(?:7|8|10|11)\b|\bwindows\b/],
  ['chromeos', /\bchrome\s*os\b|\bchromebook\b/],
  ['macos', /\bmac\s*os\b/],
  ['freedos', /\bfree\s*dos\b/],
  ['no os', /\bno\s+os\b|\bwithout\s+os\b|\bnon[\s-]?os\b/],
  ['linux', /\blinux\b|\bubuntu\b/],
];
function osFamilies(text: string): Set<string> {
  const t = prep(text);
  return new Set(OS.filter(([, re]) => re.test(t)).map(([k]) => k));
}
function windowsVersions(text: string): Set<string> {
  return new Set([...prep(text).matchAll(/\bw(?:in(?:dows)?)?\s*(7|8|10|11)\b/g)].map((m) => m[1]));
}

/** Condition words the name checks do not read (Italian, Spanish, French, German). */
const MORE_CONDITIONS: [string, RegExp][] = [
  ['refurbished', /\b(?:ricondizionat[oaie]|rigenerat[oaie]|reacondicionad[oa]s?|reconditionn[ee]e?s?|generaluberholt|recondicionad[oa])\b/],
  ['used', /\b(?:usat[oaie]|usad[oa]s?|occasion|gebraucht|seminuov[oa])\b/],
];
function allConditions(texts: string[]): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    for (const c of conditions(text)) out.add(c);
    const t = prep(text);
    for (const [k, re] of MORE_CONDITIONS) if (re.test(t)) out.add(k);
  }
  return [...out].sort();
}

/** Edition words beyond the guard's (special, anniversary, ...): one listing with one names another edition. */
const MORE_EDITIONS = new Set('special anniversary illustrated signed exclusive definitive remastered complete legendary'.split(' '));
function editions(text: string): Set<string> {
  return new Set(words(text).filter((w) => MORE_EDITIONS.has(w)));
}

const GENDER: Record<string, string> = {
  men: 'men', mens: 'men', man: 'men', male: 'men', homme: 'men', uomo: 'men', women: 'women', womens: 'women', woman: 'women', ladies: 'women',
  female: 'women', femme: 'women', donna: 'women', boys: 'boys', boy: 'boys', girls: 'girls', girl: 'girls', kids: 'kids', children: 'kids',
  unisex: 'unisex', baby: 'baby',
};
function pathGender(path: string | null | undefined): Set<string> {
  return new Set(words(path ?? '').flatMap((w) => (Object.hasOwn(GENDER, w) ? [GENDER[w]] : [])));
}

/** Letters of another script inside a Latin word (Ultrа with a Cyrillic a): a look-alike title. */
const LOOKALIKE = /\p{Script=Latin}[\p{Script=Cyrillic}\p{Script=Greek}]|[\p{Script=Cyrillic}\p{Script=Greek}]\p{Script=Latin}/u;

const compactBrand = (b: string | null | undefined) => (b ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function brandConflict(a: VetoListing, b: VetoListing): string | null {
  const ba = compactBrand(a.brand);
  const bb = compactBrand(b.brand);
  const ta = compactText(a.title);
  const tb = compactText(b.title);
  if (ba !== '' && bb !== '' && ba !== bb && !tb.includes(ba) && !ta.includes(bb) && !ba.includes(bb) && !bb.includes(ba)) return `brand ${a.brand} vs ${b.brand}`;
  // one shop names a brand the other listing neither has nor writes (an Apple case and a case for an iPhone)
  if (ba !== '' && bb === '' && !tb.includes(ba)) return `brand ${a.brand} vs none`;
  if (bb !== '' && ba === '' && !ta.includes(bb)) return `brand none vs ${b.brand}`;
  return null;
}

const show = (s: Set<string | number> | string[]) => ([...s].length === 0 ? 'none' : [...s].sort().join(' '));
const equalSets = <T>(a: Set<T>, b: Set<T>) => a.size === b.size && [...a].every((x) => b.has(x));
const subset = <T>(a: Set<T>, b: Set<T>) => [...a].every((x) => b.has(x));
/** Both name a value of the class and they are not the same values. */
const bothDiffer = <T>(a: Set<T>, b: Set<T>) => a.size > 0 && b.size > 0 && !equalSets(a, b);
/** Each has a value the other lacks. */
const eachLacks = <T>(a: Set<T>, b: Set<T>) => !subset(a, b) && !subset(b, a);

const GUARD_FIELDS = ['condition', 'money', 'gender', 'audience', 'platform', 'concentration', 'edition', 'format', 'bundle', 'pack words', 'GPU memory', 'Windows edition', 'dose form'];

/**
 * Why two listings cannot be one product, as short reasons; empty when nothing in their data disagrees. Text in a
 * title is only ever read as words, never as instructions.
 */
export function vetoReasons(a: VetoListing, b: VetoListing): string[] {
  const reasons: string[] = [];
  const brands = [a.brand, b.brand].filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  const ta = withoutBrands(a.title, brands);
  const tb = withoutBrands(b.title, brands);
  const va = (a.variantTitles ?? []).map((t) => withoutBrands(t, brands));
  const vb = (b.variantTitles ?? []).map((t) => withoutBrands(t, brands));
  const xa = [ta, ...va];
  const xb = [tb, ...vb];
  const add = (r: string | null) => {
    if (r) reasons.push(r);
  };

  // the category: neighbours only when a model code ties them (AirPods filed under phones at one shop)
  const codesA = modelCodes(ta);
  const codesB = modelCodes(tb);
  if (a.category !== b.category) {
    const tied = codesA.some((c) => c.length >= 4 && codesB.includes(c));
    if (!sameOrNeighbour(a.category, b.category) || !tied) add(`category ${a.category} vs ${b.category}`);
  }
  // shared rules use the stricter category (fashion sizes only when both are fashion)
  const cat = a.category === b.category ? a.category : 'other';

  if (LOOKALIKE.test(a.title.normalize('NFKC')) || LOOKALIKE.test(b.title.normalize('NFKC'))) add('look-alike letters of another script');
  add(brandConflict(a, b));

  const qa = quantities(xa);
  const qb = quantities(xb);
  for (const cls of new Set([...qa.keys(), ...qb.keys()])) {
    const x = qa.get(cls) ?? new Set<number>();
    const y = qb.get(cls) ?? new Set<number>();
    if (x.size > 0 && y.size > 0 && eachLacks(x, y)) add(`${cls} ${show(x)} vs ${show(y)}`);
  }
  add(codeConflict(codesA, codesB, compactText(ta), compactText(tb)));
  const na = bareNumbers(ta, cat);
  const nb = bareNumbers(tb, cat);
  if (na.size > 0 && nb.size > 0 && eachLacks(na, nb)) add(`model number ${show(na)} vs ${show(nb)}`);

  const ma = modelWords(xa, cat);
  const mb = modelWords(xb, cat);
  if (!equalSets(ma, mb)) add(`model words ${show(ma)} vs ${show(mb)}`);

  const pa = packs(xa);
  const pb = packs(xb);
  if (!equalSets(pa, pb)) add(`pack count ${show(pa)} vs ${show(pb)}`);
  const pca = pieces(xa);
  const pcb = pieces(xb);
  if (bothDiffer(pca, pcb)) add(`pieces ${show(pca)} vs ${show(pcb)}`);

  const ca = allConditions(xa);
  const cb = allConditions(xb);
  if (ca.join(',') !== cb.join(',')) add(`condition ${show(ca)} vs ${show(cb)}`);

  // the title guard of name matching: condition, money, gender, audience, platform, concentration, edition, format,
  // bundle, pack words, GPU memory, Windows edition and dose form must all agree
  const ga = guardOf(ta, cat, va).split('|');
  const gb = guardOf(tb, cat, vb).split('|');
  GUARD_FIELDS.forEach((field, i) => {
    if (field === 'condition') return;
    if (ga[i] !== gb[i]) add(`${field} ${ga[i] || 'none'} vs ${gb[i] || 'none'}`);
  });

  const ea = editions(ta);
  const eb = editions(tb);
  if (!equalSets(ea, eb)) add(`edition ${show(ea)} vs ${show(eb)}`);

  const pgA = pathGender(a.categoryPath);
  const pgB = pathGender(b.categoryPath);
  const tgA = new Set(ga[2] ? ga[2].split(',') : []);
  const tgB = new Set(gb[2] ? gb[2].split(',') : []);
  if (bothDiffer(pgA, pgB)) add(`shop category ${show(pgA)} vs ${show(pgB)}`);
  else if (bothDiffer(pgA, tgB) || bothDiffer(tgA, pgB)) add(`gender ${show(pgA.size > 0 ? pgA : tgA)} vs ${show(pgB.size > 0 ? pgB : tgB)}`);

  const oa = osFamilies(ta);
  const ob = osFamilies(tb);
  if (bothDiffer(oa, ob)) add(`OS ${show(oa)} vs ${show(ob)}`);
  const wa = windowsVersions(ta);
  const wb = windowsVersions(tb);
  if (bothDiffer(wa, wb)) add(`Windows ${show(wa)} vs ${show(wb)}`);

  const sa = classWords([ta], STORAGE_TYPE);
  const sb = classWords([tb], STORAGE_TYPE);
  if (bothDiffer(sa, sb)) add(`storage type ${show(sa)} vs ${show(sb)}`);
  const sim1 = sims(xa);
  const sim2 = sims(xb);
  if (!equalSets(sim1, sim2)) add(`SIM ${show(sim1)} vs ${show(sim2)}`);
  const ra = regions(ta);
  const rb = regions(tb);
  if (bothDiffer(ra, rb)) add(`region ${show(ra)} vs ${show(rb)}`);
  const mta = classWords(xa, MATERIAL);
  const mtb = classWords(xb, MATERIAL);
  if (bothDiffer(mta, mtb)) add(`material ${show(mta)} vs ${show(mtb)}`);
  if (cat !== 'fashion' && cat !== 'sports') {
    const za = classWords([ta], SIZE_WORD);
    const zb = classWords([tb], SIZE_WORD);
    if (bothDiffer(za, zb)) add(`size ${show(za)} vs ${show(zb)}`);
  }
  const vya = varieties(xa, cat);
  const vyb = varieties(xb, cat);
  if (!equalSets(vya, vyb)) add(`variety ${show(vya)} vs ${show(vyb)}`);
  return reasons;
}

export type VetoResult = {
  /** Claude's clusters after the veto, only those with two or more listings */
  clusters: number[][];
  /** every pair Claude put together that the veto overruled, with the reasons */
  vetoed: { a: number; b: number; reasons: string[] }[];
};

/**
 * Applies the veto to Claude's clusters (lists of indexes into listings): within each cluster every pair is checked,
 * and the cluster is split greedily (in order) so no vetoed pair stays together. Listings left alone are dropped.
 */
export function applyVeto(listings: VetoListing[], clusters: number[][]): VetoResult {
  const out: number[][] = [];
  const vetoed: VetoResult['vetoed'] = [];
  for (const cluster of clusters) {
    const members = [...new Set(cluster)].filter((i) => i >= 0 && i < listings.length).sort((x, y) => x - y);
    const bad = new Set<string>();
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const reasons = vetoReasons(listings[members[i]], listings[members[j]]);
        if (reasons.length > 0) {
          vetoed.push({ a: members[i], b: members[j], reasons });
          bad.add(`${members[i]}|${members[j]}`);
        }
      }
    }
    const parts: number[][] = [];
    for (const m of members) {
      const home = parts.find((p) => p.every((x) => !bad.has(`${Math.min(x, m)}|${Math.max(x, m)}`)));
      if (home) home.push(m);
      else parts.push([m]);
    }
    for (const p of parts) if (p.length >= 2) out.push(p);
  }
  return { clusters: out, vetoed };
}
