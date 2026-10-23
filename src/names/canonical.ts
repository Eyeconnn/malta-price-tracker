// Canonical names (design "Update 23 Oct: match by canonical normalised names"). Two shops' listings are the same
// product when their canonical names are exactly equal within one category. The name is written by code from the
// identity fields Claude returns (the category's "canonical" pattern in config/attribute-schemas.json, then the
// shared distinguishing fields), never taken from Claude's free text, with case, spacing, punctuation, units,
// ordinals and roman numerals, fragrance concentrations, CPU vendor words and TV region suffixes made equal.
// Colour and size are never part of it (except the size of a nappy sold as one size: baby nappy_size).
//
// checkCanonical keeps the fields honest against the shop title, the other way round from a list of required
// words (review of 013b134): EVERY token of the title must be in the canonical name, compared on the joined,
// normalised string, unless it is a colour or size word, a word of the shop's variant titles, the value of a field
// outside the pattern (the RAM of a laptop pattern without it, the panel of a TV, the style of a whisky), a
// percent-off or price word, a CPU vendor word, or a filler word (smartphone, console, tv, smart, 4k, wireless,
// the, for, with, new, official, ...). A field left empty therefore loses a word of the title and the listing gets
// no canonical name instead of the name of another product. It also needs the brand when the pattern has one, a
// single value per pattern quantity (variant titles with 128GB and 256GB give none), and no number the shop data
// does not have.
import raw from '../../config/attribute-schemas.json' with { type: 'json' };
import { nameKey, nameTokens, numberSpecText } from '../site/identity.js';
import { basicBrandStatus, hasBrand, keepsBrand, type BrandStatus } from './brand.js';
import { BARCODE, requiredText, SIZE_TOKENS, stripNoise } from './check.js';
import { parseAttributeSchemas, type AttributeSchemas } from './schema.js';
import { canonText, withoutGpuMemory } from './canon-text.js';
import { compact, conditions, moneyValues, packCounts, prep, quantityClass, withoutConditionsAndMoney } from './text.js';

export { canonText };

/** Fields that follow every pattern when present, in this order. */
export const SHARED_TAIL = ['condition', 'audience', 'pack_count', 'edition', 'format', 'refill', 'bundle', 'face_value'] as const;
/** The fields of the product line: a canonical name needs one. */
const CORE = new Set(['model', 'line']);
const VARIANT_KEYS = new Set(['colour', 'size', 'sizes']);

type RawCats = { categories?: Record<string, Record<string, unknown>> };

/** Each category's pattern: a list of parts, each the first present of its fields ("model|line"). */
export function parseCanonicalPatterns(file: unknown): Record<string, string[][]> {
  const out: Record<string, string[][]> = {};
  const shared = ((file as { shared?: Record<string, unknown> }).shared ?? {}) as Record<string, unknown>;
  for (const [slug, cat] of Object.entries((file as RawCats).categories ?? {})) {
    const list = cat.canonical;
    if (!Array.isArray(list) || list.length === 0) throw new Error(`attribute schemas: ${slug} has no canonical pattern`);
    out[slug] = list.map((part) => {
      const keys = String(part).split('|');
      for (const k of keys) {
        if (VARIANT_KEYS.has(k)) throw new Error(`attribute schemas: ${slug} canonical has ${k}, a variant option`);
        if (!Object.hasOwn(cat, k) && !Object.hasOwn(shared, k)) throw new Error(`attribute schemas: ${slug} canonical names unknown field ${k}`);
      }
      return keys;
    });
  }
  return out;
}

const PATTERNS = parseCanonicalPatterns(raw);
const SCHEMAS: AttributeSchemas = parseAttributeSchemas(raw);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** A category's pattern as the prompt writes it: "brand model|line storage_gb". */
export function canonicalPattern(category: string): string {
  return (PATTERNS[category] ?? []).map((p) => p.join('|')).join(' ');
}

/** The tokens of a text in that spelling. */
const canonToks = (s: string) => nameTokens(canonText(s));

/** CPU and GPU makers' words: "Intel Core i5-1335U" is i5-1335U; "Ryzen 7" is R7. */
const VENDOR_WORDS = new Set(['intel', 'core', 'amd', 'ryzen', 'nvidia', 'geforce', 'radeon', 'qualcomm', 'mediatek', 'processor', 'cpu', 'gpu', 'graphics']);
function cpuText(v: string): string {
  return canonText(v)
    .replace(/\bryzen\s+(\d)\b/g, 'r$1')
    .split(/\s+/)
    .filter((w) => w !== '' && !VENDOR_WORDS.has(w.replace(/[^\p{L}\p{N}]/gu, '')))
    .join(' ');
}

/** TV region suffixes: QE55Q60DAUXXU and OLED55C46LA are the models QE55Q60D and OLED55C46. */
const TV_SUFFIX = /(auxxu|aexxu|atxxu|axxu|xxu|exu|zeu|zep|zap|zea|aeu|aep|pla|plb|la|lb)$/;
function tvBase(code: string): string {
  const t = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  const m = TV_SUFFIX.exec(t);
  if (!m) return t;
  const base = t.slice(0, -m[1].length);
  return base.length >= 6 && (base.match(/\d/g) ?? []).length >= 3 ? base : t;
}

/** One field written as the canonical name has it, or null when absent (a pack of 1, new, adult, refill no). */
function fieldText(category: string, key: string, v: unknown): string | null {
  const spec = SCHEMAS[category]?.[key];
  if (v === null || v === undefined || Array.isArray(v)) return null;
  switch (key) {
    case 'pack_count':
      return finite(v) && v > 1 ? `pack of ${v}` : null;
    case 'refill':
      return v === 'yes' ? 'refill' : null;
    case 'bundle':
      return text(v) ? `with ${text(v)}` : null;
    case 'face_value': {
      const m = typeof v === 'string' ? moneyValues(v) : [];
      return m.length > 0 ? m.join(' ') : null;
    }
    case 'age_years':
      return finite(v) && v > 0 ? `${v} year old` : null;
    case 'cpu':
    case 'gpu':
      return text(v) ? cpuText(text(v)!) || null : null;
    case 'model':
      return text(v) ? (category === 'tv-audio' ? text(v)!.split(/\s+/).map(tvBase).join(' ') : text(v)) : null;
    default:
      if (spec?.type === 'number') return finite(v) && v > 0 ? numberSpecText(key, spec.unit, v) : null;
      return text(v);
  }
}

/** The fields of a listing's canonical name, in order, as text: [field, text]. Empty without the brand (when the
 *  pattern has one) or the product line. */
export function canonicalParts(category: string, attrs: Record<string, unknown>): [string, string][] {
  const pattern = PATTERNS[category];
  if (!pattern) return [];
  const parts: [string, string][] = [];
  for (const keys of pattern) {
    for (const k of keys) {
      const t = fieldText(category, k, attrs[k]);
      if (t !== null) {
        parts.push([k, t]);
        break;
      }
    }
  }
  if (!parts.some(([k]) => CORE.has(k))) return [];
  if (pattern.some((p) => p.includes('brand')) && !parts.some(([k]) => k === 'brand')) return [];
  const used = new Set(pattern.flat());
  for (const k of SHARED_TAIL) {
    if (used.has(k)) continue;
    const t = fieldText(category, k, attrs[k]);
    if (t !== null) parts.push([k, t]);
  }
  return parts;
}

/** The canonical name: each field in one spelling (nameKey), joined by spaces; null without brand or line. */
export function canonicalName(category: string, attrs: Record<string, unknown>): string | null {
  const parts = canonicalParts(category, attrs);
  if (parts.length === 0) return null;
  return parts
    .map(([, t]) => nameKey(canonText(t)))
    .filter((t) => t !== '')
    .join(' ');
}

export type CanonicalSource = { title: string; brand: string | null; brandStatus?: BrandStatus; variantTitles?: string[]; mpn?: string | null };
export type CanonicalCheck = { ok: true; canonical: string } | { ok: false; reason: string };

/** Words a title may have that say nothing about which product it is. */
const FILLER = new Set(
  ('smartphone smartphones phone mobile console consoles tv television smart 4k 8k uhd hd fhd wireless bluetooth smartwatch ' +
    'notebook notebooks laptop laptops office gaming earphones earphone earbuds headphones headphone headset inear onear overear ' +
    'speaker speakers portable soundbar the a an for of with and in to new latest official original genuine ' +
    'edition version model series gen generation inch inches channel ssd hdd emmc ram storage memory unit pcs piece pieces ' +
    'pack pk cans can bottles bottle nappies diapers capsules tablets pods sachets wipes rolls bags copilotpc')
    .split(' '),
);
/** Percent-off, price and sale words. */
const PRICE_WORDS = new Set('sale offer offers deal deals discount save off now only price special promo free delivery shipping clearance friday cyber monday bestseller best seller'.split(' '));
/** Colour words: the shared colour list and the shop colour names (Phantom, Midnight, Titanium, ...). */
const COLOUR_WORDS = new Set([
  ...((raw as { lists?: { colours?: string[] } }).lists?.colours ?? []).flatMap((c) => canonToks(c)),
  ...('black white silver grey gray blue red green pink purple gold yellow orange beige brown navy titanium natural desert midnight ' +
    'starlight graphite space sage mist lavender cream rose violet teal mint coral obsidian porcelain phantom ocean icy onyx jet arctic ' +
    'pastel dark light matte metallic multicolor multi transparent clear')
    .split(' '),
]);
/** Brand names a product word implies (an iPhone is an Apple). */
const IMPLIED_BRAND: Record<string, string> = { iphone: 'apple', ipad: 'apple', macbook: 'apple', imac: 'apple', airpods: 'apple' };

/** 4G, 5G and LTE are network words, never grams. */
const qty = (t: string) => (/^[2-6]g$/.test(t) ? null : quantityClass(t));

/** The value of a number field in its unit class (storage_gb 1024 is gb 1024; capacity_l 1.7 is ml 1700). */
function fieldClassValue(category: string, key: string, v: unknown): { cls: string; value: number } | null {
  const spec = SCHEMAS[category]?.[key];
  if (!finite(v) || spec?.type !== 'number' || !spec.unit) return null;
  return qty(nameTokens(numberSpecText(key, spec.unit, v)).find((t) => /\d/.test(t)) ?? '');
}

/** The checks of the file header. attrs must already be checked (checkAttrs). */
export function checkCanonical(source: CanonicalSource, category: string, attrs: Record<string, unknown>): CanonicalCheck {
  const pattern = PATTERNS[category] ?? [];
  const hasBrandPart = pattern.some((p) => p.includes('brand'));
  if (hasBrandPart && !text(attrs.brand)) return { ok: false, reason: 'no brand' };
  const parts = canonicalParts(category, attrs);
  if (parts.length === 0) return { ok: false, reason: 'no product line or model' };
  const canonical = canonicalName(category, attrs)!;
  const readable = parts.map(([, t]) => t).join(' ');
  const cToks = canonToks(readable);
  const cSet = new Set(cToks);
  const joined = cToks.join('');
  const cQty = cToks.map(qty).filter((q): q is { cls: string; value: number } => q !== null);
  const titleToks = nameTokens(source.title);
  const problems: string[] = [];

  // brand: kept when it names the maker, and never one the shop data does not have (an iPhone is an Apple)
  if (hasBrandPart) {
    const status = source.brandStatus ?? basicBrandStatus(source.brand);
    const brand = text(attrs.brand)!;
    const implied = titleToks.some((t) => IMPLIED_BRAND[t] === compact(brand));
    if (status === 'reliable' && source.brand && !keepsBrand(cToks, source.brand, titleToks) && !implied) problems.push(`brand ${source.brand} missing`);
    if (!hasBrand(titleToks, brand) && !(source.brand && compact(source.brand) === compact(brand)) && !implied) problems.push(`brand ${brand} not in the shop data`);
  }

  // the words a title may have beyond the canonical name
  const used = new Set(parts.map(([k]) => k));
  const exempt = new Set<string>([...FILLER, ...PRICE_WORDS, ...VENDOR_WORDS, ...COLOUR_WORDS]);
  const exemptQty: { cls: string; value: number }[] = [];
  for (const v of source.variantTitles ?? []) for (const t of canonToks(v)) exempt.add(t);
  if ((source.brandStatus ?? basicBrandStatus(source.brand)) !== 'reliable' && source.brand) for (const t of canonToks(source.brand)) exempt.add(t);
  // a set number names a toy: the words of its line may stay out of the canonical name
  const setNumber = category === 'toys' && used.has('model') && /\d{4,}/.test(String(attrs.model ?? ''));
  // a pack the title says in words (Twin Pack) is the pack count
  const titlePacks = packCounts(source.title, { pieces: false });
  for (const p of titlePacks) if (p.word !== null && attrs.pack_count === p.n) exempt.add(p.word);
  // the word bundle, when the bundle field says what comes with it
  if (text(attrs.bundle)) exempt.add('bundle');
  const inPattern = (k: string) => pattern.some((p) => p.includes(k)) || (SHARED_TAIL as readonly string[]).includes(k);
  for (const [k, v] of Object.entries(attrs)) {
    // a field of the pattern (used or an unused alternative such as line next to model) never excuses a word
    if (inPattern(k) && !(setNumber && k === 'line')) continue;
    // a nappy size is identity: listed sizes do not excuse it
    if (category === 'baby' && k === 'sizes') continue;
    const q = fieldClassValue(category, k, v);
    if (q) exemptQty.push(q);
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string') for (const t of canonToks(x)) exempt.add(t);
  }
  const sizes = new Set((Array.isArray(attrs.sizes) ? attrs.sizes : []).flatMap((x) => (typeof x === 'string' ? canonToks(x) : [])));
  const patternClasses = new Set(pattern.flat().map((k) => fieldClassValue(category, k, 1)?.cls).filter((c): c is string => !!c));
  const moneyNumbers = new Set(moneyValues(source.title).map((m) => Number(m.replace(/^\D+/, ''))));
  const mpn = source.mpn ? compact(source.mpn) : '';

  // the title in the canonical spelling, without percent off, prices, CPU/GPU/OS names the fields hold and maker
  // part numbers (SM-S921B, the MPN)
  // the GPU memory next to the GPU is read by the title guard of name matching (gpuMemory), not by the fields
  let titleText = canonText(withoutConditionsAndMoney(requiredText(stripNoise(withoutGpuMemory(prep(source.title))), attrs))).replace(/\bsm-?[a-z]\d{3,4}[a-z0-9/]*\b/g, ' ');
  // a spaced + joins a bundle (the guard and the bundle field check it), it is not the model word Plus
  titleText = titleText.replace(/(^|\s)\+(?=\s|$)/g, '$1 ');
  const required = nameTokens(titleText);
  const lost = new Set<string>();
  required.forEach((t, i) => {
    if (t === '' || exempt.has(t) || BARCODE.test(t) || (mpn !== '' && compact(t) === mpn)) return;
    // the words of a set (Technic Lamborghini Sian) may go when its set number is there
    if (setNumber && /^\p{L}+$/u.test(t)) return;
    if (category !== 'baby' && (SIZE_TOKENS.has(t) || t === 'size' || required[i - 1] === 'size' || sizes.has(t))) return;
    if (/^\d+(?:\.\d+)?$/.test(t) && moneyNumbers.has(Number(t))) return;
    const tt = category === 'tv-audio' && /\d/.test(t) && /[a-z]/.test(t) ? tvBase(t) : t;
    const q = qty(tt);
    if (q) {
      if (cQty.some((c) => c.cls === q.cls && c.value === q.value)) return;
      if (exemptQty.some((c) => c.cls === q.cls && c.value === q.value)) return;
      // a quantity of a class the pattern has no field for (4K is not a pattern field)
      if (patternClasses.has(q.cls)) lost.add(tt);
      return;
    }
    if (cSet.has(tt)) return;
    // a code survives inside a longer code or written apart (NE 3850 is NE3850; C4 in OLED55C46): on the joined string
    if (/\d/.test(tt) && (tt.length >= 3 || /\p{L}/u.test(tt)) && joined.includes(tt)) return;
    if (/^\p{L}+$/u.test(tt) && cToks.some((c) => /\d/.test(c) && c.includes(tt))) return;
    lost.add(tt);
  });
  if (lost.size > 0) problems.push(`lost tokens: ${[...lost].join(', ')}`);

  // one value per pattern quantity: variant titles with 128GB and 256GB are two products, not one canonical name
  for (const keys of pattern) {
    for (const k of keys) {
      const cls = fieldClassValue(category, k, 1)?.cls;
      if (!cls) continue;
      const values = new Set((source.variantTitles ?? []).flatMap((v) => canonToks(v).map(qty)).filter((q) => q?.cls === cls).map((q) => q!.value));
      if (values.size > 1) problems.push(`variants differ in ${k}`);
    }
  }

  const canonConditions = new Set(conditions(readable));
  const lostConditions = conditions(source.title).filter((c) => !canonConditions.has(c));
  if (lostConditions.length > 0) problems.push(`condition lost: ${lostConditions.join(', ')}`);
  const canonMoney = new Set(moneyValues(readable));
  const lostMoney = moneyValues(source.title).filter((m) => !canonMoney.has(m));
  if (lostMoney.length > 0) problems.push(`currency value lost: ${lostMoney.join(', ')}`);
  const lostPacks = titlePacks.filter((p) => !cSet.has(String(p.n)) && !(p.word !== null && cSet.has(p.word)));
  if (lostPacks.length > 0) problems.push(`pack size lost: ${lostPacks.map((p) => p.n).join(', ')}`);
  const plain = canonText(source.title);
  if ((/(?:^|\s)\+\s*[\p{L}\p{N}]/u.test(plain) || /\bbundle\b/.test(plain)) && !text(attrs.bundle)) problems.push('bundle lost');
  if (/\brefills?\b/.test(plain) && attrs.refill !== 'yes') problems.push('refill lost');

  // no number the shop data does not have (a guessed storage, a model number from memory)
  const dataToks = canonToks([source.title, ...(source.variantTitles ?? []), source.mpn ?? ''].join(' \n '));
  const dataQty = dataToks.map(qty).filter((q): q is { cls: string; value: number } => q !== null);
  const dataJoined = dataToks.join('');
  const dataNumbers = new Set(dataToks.flatMap((t) => (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)));
  for (const p of titlePacks) dataNumbers.add(p.n);
  const invented = new Set<string>();
  for (const [key, t] of parts) {
    if (key === 'face_value') continue;
    const fieldQ = fieldClassValue(category, key, attrs[key]);
    if (fieldQ) {
      if (!dataQty.some((q) => q.cls === fieldQ.cls && q.value === fieldQ.value)) invented.add(nameTokens(t).find((x) => /\d/.test(x)) ?? t);
      continue;
    }
    for (const tok of canonToks(t)) {
      if (!/\d/.test(tok)) continue;
      const known = dataJoined.includes(tok) || (tok.match(/\d+(?:\.\d+)?/g) ?? []).every((n) => dataNumbers.has(Number(n)));
      if (!known) invented.add(tok);
    }
  }
  if (invented.size > 0) problems.push(`not in the shop data: ${[...invented].join(', ')}`);

  return problems.length > 0 ? { ok: false, reason: problems.join('; ') } : { ok: true, canonical };
}
