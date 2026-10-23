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
import { BARCODE, requiredText, stripNoise } from './check.js';
import { parseAttributeSchemas, type AttributeSchemas } from './schema.js';
import { bundleWords, canonText, PRICE_INCLUDES, withoutGpuMemory } from './canon-text.js';
import { compact, conditions, moneyValues, packCounts, prep, quantityClass, withoutConditionsAndMoney } from './text.js';

export { canonText };

/** Fields that follow every pattern when present, in this order. */
export const SHARED_TAIL = ['condition', 'audience', 'pack_count', 'edition', 'format', 'refill', 'bundle', 'face_value'] as const;
/** The fields of the product line: a canonical name needs one. */
const CORE = new Set(['model', 'line']);
const VARIANT_KEYS = new Set(['colour', 'size', 'sizes', 'size_system']);

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

const SIM_TEXT: Record<string, string> = { single: 'single sim', dual: 'dual sim', eSIM: 'esim', 'dual + eSIM': 'dual sim esim' };

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
    case 'edition':
    case 'format': {
      // one order, without the word edition: "Edition Ultimate", "Ultimate Edition" and "Ultimate" are one
      const words = text(v) ? canonToks(text(v)!).filter((w) => w !== 'edition').sort() : [];
      return words.length > 0 ? words.join(' ') : null;
    }
    case 'sim':
      return SIM_TEXT[String(v)] ?? text(v);
    case 'wireless':
      return v === 'yes' ? 'wireless' : v === 'no' ? 'wired' : null;
    case 'os':
      return v === 'none' ? null : text(v);
    case 'energy_class':
      return text(v) ? `energy ${text(v)}` : null;
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
  const used = new Set(parts.map(([k]) => k));
  const have = new Set(parts.flatMap(([, t]) => canonToks(t)));
  // then the shared fields, then every other field the category has (an unused "model|line" alternative too), in
  // schema order: a field value is in the name or nowhere, so it never excuses a title word that the name lacks
  // (re-review of 82f7062). A field whose words the name already has adds nothing. Never colour or size.
  const rest = [...SHARED_TAIL, ...Object.keys(SCHEMAS[category] ?? {})];
  for (const k of rest) {
    if (used.has(k) || VARIANT_KEYS.has(k)) continue;
    used.add(k);
    const t = fieldText(category, k, attrs[k]);
    if (t === null) continue;
    const toks = canonToks(t);
    if (toks.length === 0 || toks.every((x) => have.has(x))) continue;
    for (const x of toks) have.add(x);
    parts.push([k, t]);
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

/** Words a title may have that say nothing about which product it is (not New, Original or SSD: they can). */
const FILLER = new Set(
  ('smartphone smartphones phone mobile console consoles tv television smart 4k 8k uhd hd fhd wireless bluetooth smartwatch ' +
    'notebook notebooks laptop laptops office gaming earphones earphone earbuds headphones headphone headset inear onear overear ' +
    'speaker speakers portable soundbar the a an for of with and in to latest official genuine ' +
    'edition version model series gen generation inch inches channel ram storage memory unit pcs piece pieces ' +
    'pack pk cans can bottles bottle nappies diapers capsules capsule tablets tablet caplets pods sachets wipes rolls bags copilotpc')
    .split(' '),
);
/** Percent-off, price and sale words (not Special: Special Edition is a product). */
const PRICE_WORDS = new Set('sale offer offers deal deals discount save off now only price promo free delivery shipping clearance friday cyber monday bestseller best seller'.split(' '));
/** Colour words: the shared colour list and the shop colour names (Phantom, Midnight, Titanium, ...). */
const COLOUR_WORDS = new Set([
  ...((raw as { lists?: { colours?: string[] } }).lists?.colours ?? []).flatMap((c) => canonToks(c)),
  ...('black white silver grey gray blue red green pink purple gold yellow orange beige brown navy titanium natural desert midnight ' +
    'starlight graphite space sage mist lavender cream rose violet teal mint coral obsidian porcelain phantom ocean icy onyx jet arctic ' +
    'pastel dark light matte metallic multicolor multi transparent clear')
    .split(' '),
]);
/** The plain colours (the shared list): a title's Gold or Light is excused only as the listing's own colour. */
const BASIC_COLOURS = new Set([...((raw as { lists?: { colours?: string[] } }).lists?.colours ?? []).flatMap((c) => canonToks(c)), 'gray', 'grey', 'rose', 'light', 'dark']);
/** Categories whose colour words are never the product (drinks, beauty and other: Light, Pink, Rose, Gold stay). */
const COLOUR_CATEGORIES = new Set(Object.keys(SCHEMAS).filter((c) => Object.hasOwn(SCHEMAS[c], 'colour') && !['drinks', 'beauty-health', 'other'].includes(c)));
/** Brand names a product word implies (an iPhone is an Apple), never for an accessory made for it. */
const IMPLIED_BRAND: Record<string, string> = { iphone: 'apple', ipad: 'apple', macbook: 'apple', imac: 'apple', airpods: 'apple' };
const ACCESSORY_WORDS = new Set('case cases cover covers protector protectors charger chargers cable cables strap straps holder holders stand stands mount mounts adapter adapters sleeve skin glass film band bands dock tempered'.split(' '));
/** Shopify's placeholder variant title. */
const PLACEHOLDER_VARIANT = /^\s*default(?:\s+title)?\s*$/i;

/** 4G, 5G and LTE are network words, never grams. */
const qty = (t: string) => (/^[2-6]g$/.test(t) ? null : quantityClass(t));

/** The value of a number field in its unit class (storage_gb 1024 is gb 1024; capacity_l 1.7 is ml 1700). */
function fieldClassValue(category: string, key: string, v: unknown): { cls: string; value: number } | null {
  const spec = SCHEMAS[category]?.[key];
  if (!finite(v) || spec?.type !== 'number' || !spec.unit) return null;
  return qty(nameTokens(numberSpecText(key, spec.unit, v)).find((t) => /\d/.test(t)) ?? '');
}

/** The title (or a variant title) as the check reads it: canonical spelling, without the words checked otherwise. */
function checkedText(title: string, attrs: Record<string, unknown>): string {
  // the GPU memory next to the GPU is read by the title guard of name matching (gpuMemory), not by the fields;
  // percent off, prices, conditions, "incl. VAT", "Brand New", CPU/GPU/OS names the fields hold and maker part
  // numbers (SM-S921B) are checked as such or are no product words
  let t = canonText(withoutConditionsAndMoney(requiredText(stripNoise(withoutGpuMemory(prep(title))), attrs)))
    .replace(PRICE_INCLUDES, ' ')
    .replace(/\bbrand[\s-]?new\b/g, ' ')
    .replace(/\bsm-?[a-z]\d{3,4}[a-z0-9/]*\b/g, ' ');
  // a + that joins a bundle (spaced, or between two words) is checked as a bundle; Pro+ stays the model word Plus
  t = t.replace(/(^|\s)\+(?=\s*[\p{L}\p{N}]|\s|$)/gu, '$1 ').replace(/([\p{L}\p{N}])\+(?=[\p{L}\p{N}])/gu, '$1 ');
  // w/, incl. and includes are bundle words (checked below), not product words
  return t.replace(/\bw\s*\/\s*(?=[\p{L}\p{N}])/gu, ' ').replace(/\b(?:incl|inc|includes|including|included)\b\.?/g, ' ');
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
  // each field on its own: a number of one field and a unit word of the next are no quantity (RTX 5060, SSD)
  const cToks = parts.flatMap(([, t]) => canonToks(t));
  const cSet = new Set(cToks);
  const joined = cToks.join('');
  const cQty = cToks.map(qty).filter((q): q is { cls: string; value: number } => q !== null);
  const titleToks = nameTokens(source.title);
  const variants = (source.variantTitles ?? []).filter((v) => v.trim() !== '' && !PLACEHOLDER_VARIANT.test(v));
  const problems: string[] = [];

  // brand: kept when it names the maker, and never one the shop data does not have (an iPhone is an Apple, a case
  // for an iPhone is not)
  if (hasBrandPart) {
    const status = source.brandStatus ?? basicBrandStatus(source.brand);
    const brand = text(attrs.brand)!;
    const accessory = titleToks.some((t) => ACCESSORY_WORDS.has(t));
    const implied = !accessory && titleToks.some((t) => IMPLIED_BRAND[t] === compact(brand));
    if (status === 'reliable' && source.brand && !keepsBrand(cToks, source.brand, titleToks) && !implied) problems.push(`brand ${source.brand} missing`);
    if (!hasBrand(titleToks, brand) && !(source.brand && compact(source.brand) === compact(brand)) && !implied) problems.push(`brand ${brand} not in the shop data`);
  }

  // variant titles: the words every one of them has are the product's (Ultra in every variant is an Ultra); the
  // others (a colour, a size) are the variant's
  const variantToks = variants.map((v) => nameTokens(checkedText(v, attrs)));
  const shared = variantToks.length === 0 ? [] : [...new Set(variantToks[0])].filter((t) => variantToks.every((vt) => vt.includes(t)));
  const variantOnly = new Set(variantToks.flat().filter((t) => !shared.includes(t)));

  // the words a title may have beyond the canonical name
  const exempt = new Set<string>([...FILLER, ...PRICE_WORDS, ...VENDOR_WORDS, ...variantOnly]);
  if ((source.brandStatus ?? basicBrandStatus(source.brand)) !== 'reliable' && source.brand) for (const t of canonToks(source.brand)) exempt.add(t);
  // a pack the title says in words (Twin Pack) is the pack count
  const titlePacks = packCounts(source.title, { pieces: false });
  for (const p of titlePacks) if (p.word !== null && attrs.pack_count === p.n) exempt.add(p.word);
  // the word bundle, when the bundle field says what comes with it
  if (text(attrs.bundle)) exempt.add('bundle');
  // colour words: only where a colour is never the product, and only for a listing with a colour: a plain colour
  // (Black, Gold, Light) only as its own colour, a shop's colour name (Phantom, Graphite, Midnight) for any colour
  const ownColours = new Set(
    COLOUR_CATEGORIES.has(category) ? (Array.isArray(attrs.colour) ? attrs.colour : [attrs.colour]).flatMap((c) => (typeof c === 'string' ? canonToks(c) : [])) : [],
  );
  // size words: only the listing's sizes and a size after "size"; a nappy size is identity
  const sizes = new Set(category === 'baby' ? [] : (Array.isArray(attrs.sizes) ? attrs.sizes : [attrs.sizes]).flatMap((x) => (typeof x === 'string' ? canonToks(x) : [])));
  const moneyNumbers = new Set(moneyValues(source.title).map((m) => Number(m.replace(/^\D+/, ''))));
  const mpn = source.mpn ? compact(source.mpn) : '';

  const titleRequired = nameTokens(checkedText(source.title, attrs));
  const required = [...titleRequired, ...shared.filter((t) => !titleRequired.includes(t))];
  const lost = new Set<string>();
  required.forEach((t, i) => {
    if (t === '' || exempt.has(t) || BARCODE.test(t) || (mpn !== '' && compact(t) === mpn)) return;
    if (ownColours.has(t) || (ownColours.size > 0 && COLOUR_WORDS.has(t) && !BASIC_COLOURS.has(t))) return;
    if (category !== 'baby' && (sizes.has(t) || (t === 'size' && required[i + 1] !== undefined) || required[i - 1] === 'size')) return;
    if (/^\d+(?:\.\d+)?$/.test(t) && moneyNumbers.has(Number(t))) return;
    const tt = category === 'tv-audio' && /\d/.test(t) && /[a-z]/.test(t) ? tvBase(t) : t;
    // every quantity of the title is one of the canonical name (re-review of 82f7062: 2600W, 230V, 100g, 42mm)
    const q = qty(tt);
    // counts (6 x, 12 pcs) are pack sizes: the pack-size check below reads them
    if (q && (q.cls === 'x' || q.cls === 'pcs')) return;
    if (q) {
      if (!cQty.some((c) => c.cls === q.cls && c.value === q.value)) lost.add(tt);
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
      const values = new Set(variants.flatMap((v) => canonToks(v).map(qty)).filter((q) => q?.cls === cls).map((q) => q!.value));
      if (values.size > 1) problems.push(`variants differ in ${k}`);
    }
  }

  // conditions, values, packs, bundles and refills: of the title and of every variant title
  const shopTexts = [source.title, ...variants];
  const canonConditions = new Set(conditions(readable));
  const lostConditions = [...new Set(shopTexts.flatMap((s) => conditions(s)))].filter((c) => !canonConditions.has(c)).sort();
  if (lostConditions.length > 0) problems.push(`condition lost: ${lostConditions.join(', ')}`);
  const canonMoney = new Set(moneyValues(readable));
  const lostMoney = moneyValues(source.title).filter((m) => !canonMoney.has(m));
  if (lostMoney.length > 0) problems.push(`currency value lost: ${lostMoney.join(', ')}`);
  const lostPacks = titlePacks.filter((p) => !cSet.has(String(p.n)) && !(p.word !== null && cSet.has(p.word)));
  if (lostPacks.length > 0) problems.push(`pack size lost: ${lostPacks.map((p) => p.n).join(', ')}`);
  const plain = canonText(source.title);
  if (bundleWords(plain) && !text(attrs.bundle)) problems.push('bundle lost');
  if (/\brefills?\b/.test(plain) && attrs.refill !== 'yes') problems.push('refill lost');

  // no number, and no model, line or edition word, the shop data does not have (a guessed storage, iPhone 15 Pro
  // for an iPhone 15, A15s for an A15)
  const dataToks = canonToks([...shopTexts, source.brand ?? '', source.mpn ?? ''].join(' \n '));
  const dataSet = new Set(dataToks);
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
    const toks = canonToks(t);
    toks.forEach((tok, i) => {
      if (/\d/.test(tok)) {
        const known = dataJoined.includes(tok) || (key !== 'model' && key !== 'line' && (tok.match(/\d+(?:\.\d+)?/g) ?? []).every((n) => dataNumbers.has(Number(n))));
        if (!known) invented.add(tok);
        return;
      }
      if (!FORWARD_KEYS.has(key) || dataSet.has(tok)) return;
      // a word written apart in the field and together in the data (Think Book, ThinkBook)
      if (dataSet.has(`${toks[i - 1] ?? ''}${tok}`) || dataSet.has(`${tok}${toks[i + 1] ?? ''}`)) return;
      invented.add(tok);
    });
  }
  if (invented.size > 0) problems.push(`not in the shop data: ${[...invented].join(', ')}`);

  return problems.length > 0 ? { ok: false, reason: problems.join('; ') } : { ok: true, canonical };
}

/** The fields whose every word must be in the shop data (the forward check). */
const FORWARD_KEYS = new Set(['model', 'line', 'edition']);
