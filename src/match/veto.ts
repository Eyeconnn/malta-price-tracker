// The veto in code (design "Update 23 Oct, afternoon: Claude judges candidate groups side by side", point 3). When
// Claude says listings are the same product, the code overrules it whenever their titles or data disagree on a
// number with a unit, a model code or part number (colour suffixes stripped), a barcode, a bare model number (also in
// words or Roman numerals), model words (Pro, Plus, Ultra), condition, money, pack or piece count, audience, gender,
// platform, concentration, edition, format, bundle, accessory or part words, OS family, Windows version and edition,
// storage type, SIM, region (version, import, PAL or NTSC, plug, voltage), material, size words, the variety of a
// drink, food or toiletry (Light, Zero, Pink, Merlot, Cucumber), the brand, the price (more than 3 times), or the site
// category. Every fact is read from the title and every variant title; the shop's category path adds gender,
// children's audience, accessory and model words. It reuses the title guard of name matching (guardOf) and the text
// helpers of the name checks. Pure: the judge run and the site build both call it.
import { bundleWords, canonText, PRICE_INCLUDES } from '../names/canon-text.js';
import { conditions, inRun, packCounts, prep, quantityClass, QUANTITY, tokens, UNIT } from '../names/text.js';
import { COLOUR_SUFFIX, gtinIdentity, guardOf, MODEL, mpnIdentity } from '../site/matching.js';

export type VetoListing = {
  title: string;
  variantTitles?: string[];
  brand?: string | null;
  /** site category slug */
  category: string;
  /** the shop's own category path (its gender, children's, accessory and model words count) */
  categoryPath?: string | null;
  gtin?: string | null;
  mpn?: string | null;
  /** the shop: two colours one shop lists on their own may have their own barcodes */
  shopId?: number;
  /** current price in integer cents */
  priceCents?: number | null;
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

/** A text without the brands of the pair (so "Moet & Chandon" or "Black+Decker" is no bundle and "Red Bull" no variety). */
function withoutBrands(text: string, brands: string[]): string {
  let s = text;
  for (const b of brands) s = s.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(b)}(?=$|[^\\p{L}\\p{N}])`, 'giu'), '$1 ');
  return s
    // Apple Watch "GPS + Cellular" is a model, not a bundle
    .replace(/\bgps\s*\+\s*(cellular|lte)\b/gi, 'gps $1')
    .replace(/\bfree\s+(?:delivery|shipping|postage|gift|returns?)\b/gi, ' ')
    .replace(/\bspecial\s+(?:offer|price|deal|sale)s?\b/gi, ' ')
    .replace(/\b(\d)\s*-?\s*in\s*-?\s*(\d)\b/gi, '$1in$2')
    // a dotted brand is one name (b.box), not the pack word "box"
    .replace(/\b([a-z])\.([a-z]{2,})\b/gi, '$1$2');
}

/** Colour words (a colour or a marketing colour name next to "titanium" keeps it a colour). */
const COLOURS = new Set(
  ('black white silver grey gray blue red green pink purple gold yellow orange beige brown navy natural desert midnight starlight ' +
    'graphite space sage mist lavender cream rose violet teal mint coral obsidian porcelain jet onyx phantom cobalt icy amber marble ' +
    'silverblue jetblack titaniumblack whitesilver').split(' '),
);

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

/** Storage within 3% is one size: 1TB is sold as 1000GB and as 1024GB. */
const near = (cls: string) => (x: number, y: number) => (cls === 'gb' ? Math.abs(x - y) <= 0.03 * Math.max(x, y) : x === y);
const subsetBy = (a: Set<number>, b: Set<number>, eq: (x: number, y: number) => boolean) => [...a].every((x) => [...b].some((y) => eq(x, y)));

const PIECES = /\b(\d+)\s*-?\s*(?:pcs?|pieces?|pce|pz|pezzi|teile)\b/g;
function pieces(texts: string[]): Set<number> {
  const out = new Set<number>();
  for (const text of texts) for (const m of prep(text).matchAll(PIECES)) out.add(Number(m[1]));
  return out;
}

/** Things counted in a pack that the name checks' count words lack (3 Bulbs is a pack of 3). */
const COUNT_NOUNS = /\b(\d+)\s*-?\s*(?:bulbs?|batteries|pairs?|tins?|jars?|cartridges?|packets?|units|refills|blades|heads|bars|sticks|tubes|pouches|capsules?|tablets?)\b/g;

/**
 * Pack counts the texts state, written any way: Pack of 6, 6 Pack, 2-Pack, x2, 2x, 43g x4, 6 x 330ml, Set of 4,
 * 3 Bulbs, Twin, Duo, Two Pack, Single. Only counts a text states; none stated is a single item (see packs).
 */
function statedPacks(texts: string[]): Set<number> {
  const out = new Set<number>();
  for (const text of texts) {
    const t = prep(text);
    for (const p of packCounts(text, { pieces: false })) out.add(p.n);
    // x2, 43g x4 (a standalone x, not the x of a size such as 40 x 30)
    for (const m of t.matchAll(/(^|\s)x\s?(\d+)\b/g)) {
      const before = t.slice(0, m.index).trimEnd();
      if (!/[\d.]$/.test(before)) out.add(Number(m[2]));
    }
    // 2x Duracell (not 6 x 330ml, which packCounts reads)
    for (const m of t.matchAll(/\b(\d+)\s?x(?=\s|$)(?!\s*\d)/g)) out.add(Number(m[1]));
    for (const m of t.matchAll(/\bset\s+of\s+(\d+)\b/g)) out.add(Number(m[1]));
    for (const m of t.matchAll(COUNT_NOUNS)) out.add(Number(m[1]));
    if (/\b(?:two|2)[\s-]?pack\b|\bduo\b|\bdouble[\s-]?pack\b/.test(t)) out.add(2);
    if (/\bsingle\b(?!\s*(?:malt|origin|serve|sim|bed|duvet|sheet|estate|cream|grain|oven|door|use))/.test(t)) out.add(1);
  }
  return out;
}

function packs(texts: string[]): Set<number> {
  const out = statedPacks(texts);
  if (out.size === 0) out.add(1);
  return out;
}

const NUMBER = /^\d+(?:\.\d+)?$/;
const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};
const ROMAN_VALUE: Record<string, number> = { i: 1, v: 5, x: 10 };
/** A Roman numeral of 2 to 6 letters up to 39 (VII, XVI), or null; single letters are words (X, V). */
function roman(t: string): number | null {
  if (!/^x{0,3}(?:ix|iv|v?i{0,3})$/.test(t) || t.length < 2 || t.length > 6) return null;
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const v = ROMAN_VALUE[t[i]];
    const next = ROMAN_VALUE[t[i + 1]] ?? 0;
    n += v < next ? -v : v;
  }
  return n;
}

/** Bare numbers (iPhone 15, LEGO 42115, Size 4, Twelve Year Old, Final Fantasy XVI), not counts or clothing sizes. */
function bareNumbers(texts: string[], category: string): Set<number> {
  const counted = new Set([...statedPacks(texts), ...pieces(texts)]);
  const out = new Set<number>();
  for (const text of texts) {
    const toks = words(text);
    toks.forEach((t, i) => {
      const n = NUMBER.test(t) ? Number(t) : Object.hasOwn(NUMBER_WORDS, t) ? NUMBER_WORDS[t] : roman(t);
      if (n === null || counted.has(n)) return;
      if ((category === 'fashion' || category === 'sports') && /^(?:size|eu|uk|us|it|fr)$/.test(toks[i - 1] ?? '')) return;
      out.add(n);
    });
  }
  return out;
}

/** Path segments of a shop category path ("Laptops > MacBook Pro"). */
const segments = (path: string | null | undefined) => (path ?? '').split(/\s*(?:>|\/|\||»)\s*/).filter((s) => s.trim() !== '');

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

/** Accessory and part words: a case is not the phone, replacement heads are not the toothbrush. */
const ACCESSORY: Record<string, string> = {
  case: 'case', cases: 'case', cover: 'cover', covers: 'cover', protector: 'protector', protectors: 'protector', strap: 'strap', straps: 'strap',
  band: 'band', bands: 'band', charger: 'charger', chargers: 'charger', cable: 'cable', cables: 'cable', controller: 'controller', controllers: 'controller',
  replacement: 'replacement', refill: 'refill', refills: 'refill', heads: 'heads', filter: 'filter', filters: 'filter', stand: 'stand', stands: 'stand',
  adapter: 'adapter', adaptor: 'adapter', adapters: 'adapter', mount: 'mount', sleeve: 'sleeve', sleeves: 'sleeve', skin: 'skin', skins: 'skin',
  accessories: 'accessory', accessory: 'accessory',
};
/** Phrases where an accessory word names part of the product itself. */
const NOT_ACCESSORY = /\b(?:stand\s+mixer|filter\s+coffee|smart\s*band|fitness\s+band|wrist\s*band|skin\s*care|for\s+\w+\s+skin|\w+\s+skin\s+type)\b/g;

/**
 * Whether "Charging Case" in a prepped text is part of the earbuds sold: after "with", w/, +, and or incl., or
 * AirPods' "MagSafe Charging Case"; never with "for", "replacement" or "only" (a case sold on its own).
 */
function caseIsPart(t: string): boolean {
  if (/\bfor\b|\breplacement\b|\bonly\b/.test(t)) return false;
  return /(?:\bwith|\bw\s*\/|\+|\band|\bincl\w*)\s+(?:[\p{L}\p{N}-]+\s+){0,3}charging\s+case\b/u.test(t) || /\bmagsafe\s+charging\s+case\b/.test(t);
}

/** The kind of charging case named (a wireless and a plain charging case are two AirPods). */
function caseKinds(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const m of prep(text).matchAll(/\b((?:[\p{L}\p{N}-]+\s+){0,3})charging\s+case\b/gu)) {
      for (const w of m[1].split(/\s+/)) if (w === 'wireless' || w === 'lightning' || w === 'magsafe') out.add(w);
    }
  }
  return out;
}

function accessories(listing: VetoListing, title: string): Set<string> {
  const out = new Set<string>();
  const add = (text: string) => {
    const t = prep(text);
    const plain = (caseIsPart(t) ? t.replace(/\bcharging\s+case\b/g, ' ') : t).replace(NOT_ACCESSORY, ' ');
    for (const t of words(plain)) {
      if (!Object.hasOwn(ACCESSORY, t)) continue;
      if (t === 'skin' || t === 'skins') {
        if (listing.category === 'beauty-health') continue;
      }
      out.add(ACCESSORY[t]);
    }
  };
  add(title);
  // the leaf of the shop's category path ("Accessories > Phone Cases"); "Phones & Accessories" is no accessory leaf
  const leaf = segments(listing.categoryPath).at(-1) ?? '';
  if (/&|\band\b/i.test(leaf)) add(leaf.replace(/\baccessor(?:y|ies)\b/gi, ' '));
  else add(leaf);
  return out;
}

/** Things a bundle adds after "with" (not features: "with Active Noise Cancellation" is no bundle). */
const PRODUCT_NOUN =
  /^(?:case|bag|controllers?|games?|charger|cables?|headphones|headset|earbuds|stand|mouse|keyboard|sleeve|cover|strap|lens|lenses|bottles?|glass(?:es)?|mugs?|kit|accessories|batter(?:y|ies)|adapter|dock|remote|protector|voucher|card|pen|stylus|mat|bowl|tripod|microphone|mic|speaker|printer|monitor|tv|console|phone|tablet|laptop|watch|refills?|pods|capsules|heads|blades|brush|toothbrush|gift|box|set|pack|bundle|frother|aeroccino|grinder|steamer|base|station|bridge|hub)$/;

/**
 * Whether a text names a bundle: + item, incl., includes, bundle or multipack, or "with" (or w/) a product (review
 * 23 Oct: "with <feature>" and "and" are no bundle).
 */
function bundle(text: string): boolean {
  const plain = canonText(text.replace(/\bcharging\s+case\b/gi, ' ')).replace(PRICE_INCLUDES, ' ').replace(/\bw\s*\/\s*/g, ' with ');
  if (bundleWords(plain)) return true;
  const toks = words(plain);
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== 'with') continue;
    for (const t of toks.slice(i + 1, i + 4)) if (PRODUCT_NOUN.test(t)) return true;
  }
  return false;
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
    // "White Wine" after a grape names the kind of drink, not another product
    const t = prep(text).replace(/\b(?:red|white|rose|pink)\s+wine\b/g, ' wine ');
    for (const m of t.matchAll(/\b(light|medium|dark|blonde)\s+roast\b/g)) out.add(`${m[1]} roast`);
    const plain = t.replace(/\b(?:light|medium|dark|blonde)\s+roast\b/g, ' ');
    for (const w of words(plain)) {
      if (VARIETY.has(w) || (COLOUR_VARIETY_CATEGORIES.has(category) && VARIETY_COLOURS.has(w))) out.add(w);
    }
  }
  return out;
}

/** Version and import regions (a Chinese version, a Japanese import, NTSC); the European default ones say nothing. */
const REGION_DEFAULT = new Set(['global', 'eu', 'pal']);
function versionRegions(texts: string[], category: string): Set<string> {
  const out = new Set<string>();
  // a bare HK, China or Chinese names the region of a device (Chinese tea or porcelain is no region)
  const device = ['phones', 'laptops', 'tv-audio', 'gaming'].includes(category);
  const NAME: Record<string, string> = { usa: 'us', intl: 'global', international: 'global', cn: 'china', chinese: 'china', jp: 'japan', japanese: 'japan', asian: 'asia', hk: 'hong kong' };
  for (const text of texts) {
    const t = prep(text);
    for (const m of t.matchAll(/\b(eu|uk|us|usa|au|global|international|intl|asia|asian|china|chinese|cn|hk|japan|japanese|jp|korea|korean|india|indian)\s*[-/]?\s*(?:version|ver|model|spec|stock|rom|edition|import(?:ed)?|region)\b/g)) out.add(NAME[m[1]] ?? m[1]);
    if (device) for (const m of t.matchAll(/\b(hk|china|cn|chinese)\b/g)) out.add(NAME[m[1]] ?? m[1]);
    if (/\bimport(?:ed)?\b/.test(t)) out.add('import');
    if (/\bntsc\b/.test(t)) out.add('ntsc');
    if (/\bpal\b/.test(t)) out.add('pal');
  }
  return new Set([...out].filter((r) => !REGION_DEFAULT.has(r)));
}
function plugs(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    const t = prep(text);
    for (const m of t.matchAll(/\b(eu|euro|uk|us|au|swiss|ch)\s*-?\s*plug\b/g)) out.add({ euro: 'eu', ch: 'swiss' }[m[1]] ?? m[1]);
    if (/\b3[\s-]?pin\b/.test(t)) out.add('uk');
    if (/\bschuko\b/.test(t)) out.add('eu');
  }
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

/** Network and SIM facts a phone, watch or tablet title states. */
function connectivity(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    const t = prep(text);
    if (/\bdual[\s-]?sim\b|\bds\b/.test(t)) out.add('dual sim');
    if (/\be[\s-]?sim\b/.test(t)) out.add('esim');
    for (const m of t.matchAll(/\b(4g|5g|lte|cellular|gps)\b/g)) out.add(m[1]);
    if (/\bwi[\s-]?fi\b/.test(t)) out.add('wifi');
  }
  return out;
}
const NETWORK = ['dual sim', 'esim', '4g', '5g', 'lte', 'cellular'];
const MOBILE_DATA = ['cellular', 'lte', '4g'];
/** A watch or tablet: one sold with and without mobile data. */
const WATCH_OR_TABLET = /\b(?:watch|smartwatch|ipad|tablet|tab)\b/;

/** with ads or without (Kindle). */
function ads(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    const t = prep(text);
    if (/\bwithout\s+(?:ads|adverts|advertising|special\s+offers|lockscreen\s+ads)\b|\bad[\s-]?free\b/.test(t)) out.add('without ads');
    if (/\bwith\s+(?:ads|adverts|advertising|special\s+offers|lockscreen\s+ads)\b|\bad[\s-]?supported\b/.test(t)) out.add('with ads');
  }
  return out;
}

/** Battery sizes (AA, AAA, C, D, CR2032, 18650). */
function batterySizes(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    const t = prep(text);
    for (const m of t.matchAll(/\b(aaaa|aaa|aa)\b/g)) out.add(m[1]);
    for (const m of t.matchAll(/\b(c|d)\s*(?:size|cell|batter)/g)) out.add(m[1]);
    for (const m of t.matchAll(/\b(cr|lr|sr|ag)\s?-?(\d{2,4})\b/g)) out.add(`${m[1]}${m[2]}`);
    for (const m of t.matchAll(/\b(18650|21700|14500|16340|26650)\b/g)) out.add(m[1]);
  }
  return out;
}

const STARTER = /\bstarter\s+(?:kit|set|pack)\b/;

const OS: [string, RegExp][] = [
  ['windows', /\bw(?:in(?:dows)?)?\s*(?:7|8|10|11)\b|\bwindows\b/],
  ['chromeos', /\bchrome\s*os\b|\bchromebook\b/],
  ['macos', /\bmac\s*os\b/],
  ['freedos', /\bfree\s*dos\b/],
  ['no os', /\bno\s+os\b|\bwithout\s+os\b|\bnon[\s-]?os\b/],
  ['linux', /\blinux\b|\bubuntu\b/],
];
function osFamilies(texts: string[]): Set<string> {
  return new Set(texts.flatMap((text) => OS.filter(([, re]) => re.test(prep(text))).map(([k]) => k)));
}
function windowsVersions(texts: string[]): Set<string> {
  return new Set(texts.flatMap((text) => [...prep(text).matchAll(/\bw(?:in(?:dows)?)?\s*(7|8|10|11)\b/g)].map((m) => m[1])));
}

/** Condition words the name checks do not read (Italian, Spanish, French, German, box damaged). */
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
function editions(texts: string[]): Set<string> {
  return new Set(texts.flatMap((text) => words(text).filter((w) => MORE_EDITIONS.has(w))));
}

const PATH_GENDER: Record<string, string> = {
  men: 'men', mens: 'men', man: 'men', male: 'men', homme: 'men', uomo: 'men', women: 'women', womens: 'women', woman: 'women', ladies: 'women',
  female: 'women', femme: 'women', donna: 'women', unisex: 'unisex',
};
const PATH_AUDIENCE: Record<string, string> = {
  kids: 'kids', kid: 'kids', children: 'kids', childrens: 'kids', child: 'kids', junior: 'junior', juniors: 'junior', boys: 'boys', boy: 'boys', girls: 'girls',
  girl: 'girls', toddler: 'toddler', toddlers: 'toddler', youth: 'youth', baby: 'baby', infant: 'baby',
};
const pathWords = (path: string | null | undefined, map: Record<string, string>) => new Set(words(path ?? '').flatMap((w) => (Object.hasOwn(map, w) ? [map[w]] : [])));

/** Letters of another script inside a Latin word (Ultrа with a Cyrillic a): a look-alike title. */
const LOOKALIKE = /\p{Script=Latin}[\p{Script=Cyrillic}\p{Script=Greek}]|[\p{Script=Cyrillic}\p{Script=Greek}]\p{Script=Latin}/u;

/** Names of a brand people write instead (Coke for Coca-Cola), compact spelling. */
const BRAND_ALIASES: Record<string, string[]> = { cocacola: ['coke'], hewlettpackard: ['hp'], hp: ['hewlettpackard'], volkswagen: ['vw'] };

const brandWords = (b: string | null | undefined) => (b ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
const titleWords = (s: string) => brandWords(s);

/** Whether a title names the brand as whole words (Sharp is not in "Sharper Image"), before any "for ...". */
function namesBrand(title: string, brand: string[]): boolean {
  if (brand.length === 0) return false;
  // "Case for Apple iPhone 15": the brand after "for" is what it fits, not its maker
  const head = title.split(/\s(?:for|fits|compatible\s+with)\s/i)[0];
  const toks = titleWords(head);
  const compact = brand.join('');
  return inRun(toks, compact) || (BRAND_ALIASES[compact] ?? []).some((a) => toks.includes(a));
}

/** One brand's words include the other's (Apple and Apple Inc, Philips and Philips Hue). */
const sameBrand = (a: string[], b: string[]) => a.every((w) => b.includes(w)) || b.every((w) => a.includes(w));

function brandConflict(a: VetoListing, b: VetoListing): string | null {
  const ba = brandWords(a.brand);
  const bb = brandWords(b.brand);
  if (ba.length > 0 && bb.length > 0) {
    if (sameBrand(ba, bb) || namesBrand(b.title, ba) || namesBrand(a.title, bb)) return null;
    return `brand ${a.brand} vs ${b.brand}`;
  }
  // a brand field on one side only: the other title must name it (an Apple case and a case for an iPhone)
  if (ba.length > 0 && !namesBrand(b.title, ba)) return `brand ${a.brand} vs none`;
  if (bb.length > 0 && !namesBrand(a.title, bb)) return `brand none vs ${b.brand}`;
  // no brand field at all: each title's first maker word must be somewhere in the other (Tefal and Prestige pans)
  if (ba.length === 0 && bb.length === 0) {
    const wa = titleWords(a.title);
    const wb = titleWords(b.title);
    // the title's first word, when it is a word (a title starting with a number names no maker)
    const first = (w: string[]) => {
      const x = w.find((y) => !FILLER_FIRST.has(y));
      return x !== undefined && /^\p{L}[\p{L}\p{N}]+$/u.test(x) ? x : undefined;
    };
    const fa = first(wa);
    const fb = first(wb);
    if (fa && fb && !inRun(wb, fa) && !inRun(wa, fb)) return `maker ${fa} vs ${fb}`;
  }
  return null;
}

/** Words a title may start with that name no maker. */
const FILLER_FIRST = new Set('new the genuine original official brand latest sale offer deal pack set bundle'.split(' '));

const show = (s: Set<string | number> | string[]) => ([...s].length === 0 ? 'none' : [...s].sort().join(' '));
const equalSets = <T>(a: Set<T>, b: Set<T>) => a.size === b.size && [...a].every((x) => b.has(x));
const subset = <T>(a: Set<T>, b: Set<T>) => [...a].every((x) => b.has(x));
/** Both name a value of the class and they are not the same values. */
const bothDiffer = <T>(a: Set<T>, b: Set<T>) => a.size > 0 && b.size > 0 && !equalSets(a, b);
/** Each has a value the other lacks. */
const eachLacks = <T>(a: Set<T>, b: Set<T>) => !subset(a, b) && !subset(b, a);
const disjoint = <T>(a: Set<T>, b: Set<T>) => a.size > 0 && b.size > 0 && [...a].every((x) => !b.has(x));

/** The guard fields compared over the title and every variant title (condition and bundle are read on their own). */
const GUARD_FIELDS = ['condition', 'money', 'gender', 'audience', 'platform', 'concentration', 'edition', 'format', 'bundle', 'pack words', 'GPU memory', 'Windows edition', 'dose form'];
const SKIP_GUARD = new Set(['condition', 'gender', 'audience', 'bundle']);

/** Each guard field as the set of values the title and the variant titles name. */
function guardSets(texts: string[], category: string): Set<string>[] {
  const out = GUARD_FIELDS.map(() => new Set<string>());
  for (const text of texts) {
    guardOf(text, category, []).split('|').forEach((v, i) => {
      for (const x of v.split(',')) if (x !== '') out[i].add(x);
    });
  }
  // a title without a condition or money says "new" and "none"; only the values named count
  out[0].delete('new');
  out[1].delete('none');
  return out;
}

/** A price more than this many times another of the same condition is another product (a case at a phone's price). */
const PRICE_RATIO = 3;
/** The ratio when one listing names an accessory or part (a charging case at a third of the earbuds' price). */
const ACCESSORY_PRICE_RATIO = 2.5;

/**
 * Why two listings cannot be one product, as short reasons; empty when nothing in their data disagrees. Text in a
 * title is only ever read as words, never as instructions.
 */
export function vetoReasons(a: VetoListing, b: VetoListing): string[] {
  const reasons: string[] = [];
  const brands = [a.brand, b.brand].filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  const ta = withoutBrands(a.title, brands);
  const tb = withoutBrands(b.title, brands);
  const xa = [ta, ...(a.variantTitles ?? []).map((t) => withoutBrands(t, brands))];
  const xb = [tb, ...(b.variantTitles ?? []).map((t) => withoutBrands(t, brands))];
  const add = (r: string | null) => {
    if (r) reasons.push(r);
  };

  // the category: neighbours only when a model code ties them (AirPods filed under phones at one shop)
  const codesA = [...new Set(xa.flatMap(modelCodes))].sort();
  const codesB = [...new Set(xb.flatMap(modelCodes))].sort();
  if (a.category !== b.category) {
    const tied = codesA.some((c) => c.length >= 4 && codesB.includes(c));
    if (!sameOrNeighbour(a.category, b.category) || !tied) add(`category ${a.category} vs ${b.category}`);
  }
  // shared rules use the stricter category (fashion sizes only when both are fashion)
  const cat = a.category === b.category ? a.category : 'other';

  if (LOOKALIKE.test(a.title.normalize('NFKC')) || LOOKALIKE.test(b.title.normalize('NFKC'))) add('look-alike letters of another script');
  add(brandConflict(a, b));

  // barcodes and part numbers: two valid barcodes at two shops, or two part numbers, name two products
  const ga = gtinIdentity(a.gtin);
  const gb = gtinIdentity(b.gtin);
  if (ga && gb && ga !== gb && (a.shopId === undefined || b.shopId === undefined || a.shopId !== b.shopId)) add(`barcode ${ga} vs ${gb}`);
  const pa = mpnIdentity(a.mpn);
  const pb = mpnIdentity(b.mpn);
  if (pa && pb && pa !== pb) add(`part number ${pa} vs ${pb}`);

  const qa = quantities(xa);
  const qb = quantities(xb);
  for (const cls of new Set([...qa.keys(), ...qb.keys()])) {
    const x = qa.get(cls) ?? new Set<number>();
    const y = qb.get(cls) ?? new Set<number>();
    const eq = near(cls);
    if (x.size > 0 && y.size > 0 && !subsetBy(x, y, eq) && !subsetBy(y, x, eq)) add(`${cls} ${show(x)} vs ${show(y)}`);
  }
  add(codeConflict(codesA, codesB, xa.map(compactText).join(' '), xb.map(compactText).join(' ')));
  const na = bareNumbers(xa, cat);
  const nb = bareNumbers(xb, cat);
  if (na.size > 0 && nb.size > 0 && eachLacks(na, nb)) add(`model number ${show(na)} vs ${show(nb)}`);

  const ma = modelWords(xa, cat);
  const mb = modelWords(xb, cat);
  if (!equalSets(ma, mb)) add(`model words ${show(ma)} vs ${show(mb)}`);
  const pma = modelWords(segments(a.categoryPath), cat);
  const pmb = modelWords(segments(b.categoryPath), cat);
  if (disjoint(pma, pmb)) add(`shop category model ${show(pma)} vs ${show(pmb)}`);

  const pka = packs(xa);
  const pkb = packs(xb);
  if (!equalSets(pka, pkb)) add(`pack count ${show(pka)} vs ${show(pkb)}`);
  const pca = pieces(xa);
  const pcb = pieces(xb);
  if (bothDiffer(pca, pcb)) add(`pieces ${show(pca)} vs ${show(pcb)}`);

  const ca = allConditions(xa);
  const cb = allConditions(xb);
  if (ca.join(',') !== cb.join(',')) add(`condition ${show(ca)} vs ${show(cb)}`);

  // the title guard of name matching over the title and every variant title
  const ga2 = guardSets(xa, cat);
  const gb2 = guardSets(xb, cat);
  GUARD_FIELDS.forEach((field, i) => {
    if (SKIP_GUARD.has(field)) return;
    if (!equalSets(ga2[i], gb2[i])) add(`${field} ${show(ga2[i])} vs ${show(gb2[i])}`);
  });
  // gender: the title's, else the shop category's (a Men's title and a Mens path agree)
  const genderOf = (g: Set<string>, l: VetoListing) => (g.size > 0 ? g : pathWords(l.categoryPath, PATH_GENDER));
  const gna = genderOf(ga2[2], a);
  const gnb = genderOf(gb2[2], b);
  if (!equalSets(gna, gnb)) add(`gender ${show(gna)} vs ${show(gnb)}`);
  const pga = pathWords(a.categoryPath, PATH_GENDER);
  const pgb = pathWords(b.categoryPath, PATH_GENDER);
  if (bothDiffer(pga, pgb) && equalSets(gna, gnb)) add(`shop category ${show(pga)} vs ${show(pgb)}`);
  // children's audience: the titles' and, for clothing and shoes, the shop category's
  const clothing = cat === 'fashion' || cat === 'sports';
  const audA = new Set([...ga2[3], ...(clothing ? pathWords(a.categoryPath, PATH_AUDIENCE) : [])]);
  const audB = new Set([...gb2[3], ...(clothing ? pathWords(b.categoryPath, PATH_AUDIENCE) : [])]);
  if (!equalSets(audA, audB)) add(`audience ${show(audA)} vs ${show(audB)}`);

  const ba = xa.some(bundle);
  const bb = xb.some(bundle);
  if (ba !== bb) add(`bundle ${ba ? 'bundle' : 'none'} vs ${bb ? 'bundle' : 'none'}`);
  const aca = accessories(a, ta);
  const acb = accessories(b, tb);
  if ((aca.size === 0) !== (acb.size === 0)) add(`accessory ${show(aca)} vs ${show(acb)}`);
  const cka = caseKinds(xa);
  const ckb = caseKinds(xb);
  if (!equalSets(cka, ckb)) add(`charging case ${show(cka)} vs ${show(ckb)}`);
  const sta = xa.some((t) => STARTER.test(prep(t)));
  const stb = xb.some((t) => STARTER.test(prep(t)));
  if (sta !== stb) add(`starter kit ${sta ? 'yes' : 'no'} vs ${stb ? 'yes' : 'no'}`);
  const ada = ads(xa);
  const adb = ads(xb);
  if (bothDiffer(ada, adb)) add(`ads ${show(ada)} vs ${show(adb)}`);
  const bsa = batterySizes(xa);
  const bsb = batterySizes(xb);
  if (bothDiffer(bsa, bsb)) add(`battery size ${show(bsa)} vs ${show(bsb)}`);
  // network: each states a network fact the other lacks (Dual SIM and 5G), or mobile data on one side only where the
  // other says GPS or Wi-Fi, or on a watch or tablet (sold with and without it); a 5G phone whose other shop omits
  // 5G stays one product
  const cna = connectivity(xa);
  const cnb = connectivity(xb);
  const neta = new Set([...cna].filter((x) => NETWORK.includes(x)));
  const netb = new Set([...cnb].filter((x) => NETWORK.includes(x)));
  if (eachLacks(neta, netb)) add(`network ${show(neta)} vs ${show(netb)}`);
  const dataA = MOBILE_DATA.some((x) => cna.has(x));
  const dataB = MOBILE_DATA.some((x) => cnb.has(x));
  if (dataA !== dataB) {
    const without = dataA ? cnb : cna;
    const watchOrTablet = [ta, tb].some((t) => WATCH_OR_TABLET.test(prep(t)));
    if (without.has('gps') || without.has('wifi') || watchOrTablet) add(`mobile data ${dataA ? 'yes' : 'no'} vs ${dataB ? 'yes' : 'no'}`);
  }

  const ea = editions(xa);
  const eb = editions(xb);
  if (!equalSets(ea, eb)) add(`edition ${show(ea)} vs ${show(eb)}`);

  const oa = osFamilies(xa);
  const ob = osFamilies(xb);
  if (bothDiffer(oa, ob)) add(`OS ${show(oa)} vs ${show(ob)}`);
  const wa = windowsVersions(xa);
  const wb = windowsVersions(xb);
  if (bothDiffer(wa, wb)) add(`Windows ${show(wa)} vs ${show(wb)}`);

  const sa = classWords(xa, STORAGE_TYPE);
  const sb = classWords(xb, STORAGE_TYPE);
  if (bothDiffer(sa, sb)) add(`storage type ${show(sa)} vs ${show(sb)}`);
  const sim1 = sims(xa);
  const sim2 = sims(xb);
  if (bothDiffer(sim1, sim2)) add(`SIM ${show(sim1)} vs ${show(sim2)}`);
  const ra = versionRegions(xa, cat);
  const rb = versionRegions(xb, cat);
  if (!equalSets(ra, rb)) add(`region ${show(ra)} vs ${show(rb)}`);
  const pla = plugs(xa);
  const plb = plugs(xb);
  if (bothDiffer(pla, plb)) add(`plug ${show(pla)} vs ${show(plb)}`);
  const mta = classWords(xa, MATERIAL);
  const mtb = classWords(xb, MATERIAL);
  if (bothDiffer(mta, mtb)) add(`material ${show(mta)} vs ${show(mtb)}`);
  if (!clothing) {
    const za = classWords([ta], SIZE_WORD);
    const zb = classWords([tb], SIZE_WORD);
    if (bothDiffer(za, zb)) add(`size ${show(za)} vs ${show(zb)}`);
  }
  const vya = varieties(xa, cat);
  const vyb = varieties(xb, cat);
  if (!equalSets(vya, vyb)) add(`variety ${show(vya)} vs ${show(vyb)}`);

  const pra = a.priceCents ?? 0;
  const prb = b.priceCents ?? 0;
  if (pra > 0 && prb > 0 && ca.join(',') === cb.join(',') && Math.max(pra, prb) > (aca.size > 0 || acb.size > 0 ? ACCESSORY_PRICE_RATIO : PRICE_RATIO) * Math.min(pra, prb)) add(`price ${pra} vs ${prb} cents`);
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

/** Years printed in titles (2025 edition, iPhone (2025)): no identity. */
const isYear = (n: number) => Number.isInteger(n) && n >= 1990 && n <= 2035;

/** Storage in GB as one value: 1TB, 1000GB and 1024GB are one size. */
function storageValue(gb: number): number {
  if (gb < 1000) return gb;
  const tb = Math.round(gb / 1024);
  return tb > 0 && Math.abs(gb - tb * 1024) <= 0.03 * gb ? tb * 1024 : gb;
}

/**
 * What names one model in a title, for the judge's splitting and merge pass (src/match/candidates.ts, merge.ts):
 * numbers (numbers with a unit, storage as its largest value so 12GB of RAM next to 512GB of storage is left out,
 * and bare model numbers, years left out) and model words (Pro, Max, Ultra). Colour words are never part of it.
 */
export function identityOf(title: string, category: string): { numbers: string[]; models: string[] } {
  const numbers = new Set<string>();
  for (const [cls, values] of quantities([title])) {
    if (cls === 'gb') numbers.add(`gb${storageValue(Math.max(...values))}`);
    else for (const v of values) numbers.add(`${cls}${v}`);
  }
  for (const n of bareNumbers([title], category)) if (!isYear(n)) numbers.add(`n${n}`);
  return { numbers: [...numbers].sort(), models: [...modelWords([title], category)].sort() };
}

/** The colour words of a title (Deep Blue is blue, Cosmic Orange is orange). */
export function colourWords(title: string): string[] {
  return [...new Set(words(title).filter((w) => COLOURS.has(w)))].sort();
}
