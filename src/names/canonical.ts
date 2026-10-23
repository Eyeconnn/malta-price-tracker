// Canonical names (design "Update 23 Oct: match by canonical normalised names"). Two shops' listings are the same
// product when their canonical names are exactly equal within one category. The name is written by code from the
// identity fields Claude returns (the category's "canonical" pattern in config/attribute-schemas.json, then the
// shared distinguishing fields), never taken from Claude's free text, with case, spacing, punctuation and units made
// equal (nameKey per field, numbers in the attribute's unit). Colour and size are never part of it.
//
// checkCanonical keeps the fields honest against the shop title: the canonical name must keep the brand, every model
// code, number and distinguishing word of the title (model words, edition and format words, condition, audience,
// pack size, values with a currency, bundle, refill), must have a field for a storage, volume or other quantity the
// title names when the pattern has one, and may not hold a number the shop data does not have.
import raw from '../../config/attribute-schemas.json' with { type: 'json' };
import { nameKey, nameTokens, numberSpecText } from '../site/identity.js';
import { basicBrandStatus, hasBrand, keepsBrand, type BrandStatus } from './brand.js';
import { BARCODE, isCode, NAME_WORDS, requiredText, SIZE_TOKENS, stripNoise } from './check.js';
import { parseAttributeSchemas, type AttributeSchemas } from './schema.js';
import { compact, conditions, inRun, moneyValues, packCounts, prep, quantityClass } from './text.js';

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
    default:
      if (spec?.type === 'number') return finite(v) && v > 0 ? numberSpecText(key, spec.unit, v) : null;
      return text(v);
  }
}

/** A category's pattern as the prompt writes it: "brand model|line storage_gb". */
export function canonicalPattern(category: string): string {
  return (PATTERNS[category] ?? []).map((p) => p.join('|')).join(' ');
}

/** The fields of a listing's canonical name, in order, as text: [field, text]. Empty without the product line. */
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
  const used = new Set(pattern.flat());
  for (const k of SHARED_TAIL) {
    if (used.has(k)) continue;
    const t = fieldText(category, k, attrs[k]);
    if (t !== null) parts.push([k, t]);
  }
  return parts;
}

/** The canonical name: each field in one spelling (nameKey), joined by spaces; null without the product line. */
export function canonicalName(category: string, attrs: Record<string, unknown>): string | null {
  const parts = canonicalParts(category, attrs);
  if (parts.length === 0) return null;
  return parts
    .map(([, t]) => nameKey(t))
    .filter((t) => t !== '')
    .join(' ');
}

export type CanonicalSource = { title: string; brand: string | null; brandStatus?: BrandStatus; variantTitles?: string[]; mpn?: string | null };
export type CanonicalCheck = { ok: true; canonical: string } | { ok: false; reason: string };

/** Audience words the canonical name must keep when the title has them. */
const AUDIENCE_WORDS = new Set(['kids', 'kid', 'junior', 'boys', 'girls', 'baby', 'toddler', 'youth']);
/** A bundle the title names: a spaced + with an item, or the word bundle. */
const BUNDLE = [/(?:^|\s)\+\s*[\p{L}\p{N}]/u, /\bbundle\b/];

/** The unit class of each number field of a category's pattern (storage_gb is gb, volume_ml is ml, ...). */
function patternClasses(category: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const keys of PATTERNS[category] ?? []) {
    for (const k of keys) {
      const spec = SCHEMAS[category]?.[k];
      if (spec?.type !== 'number' || !spec.unit) continue;
      const q = quantityClass(nameTokens(numberSpecText(k, spec.unit, 1)).find((t) => /\d/.test(t)) ?? '');
      if (!q) continue;
      out.set(q.cls, [...(out.get(q.cls) ?? []), k]);
    }
  }
  return out;
}

/** The value of a number field in its unit class (storage_gb 1024 is gb 1024; capacity_l 1.7 is ml 1700). */
function fieldClassValue(category: string, key: string, v: unknown): { cls: string; value: number } | null {
  const spec = SCHEMAS[category]?.[key];
  if (!finite(v) || spec?.type !== 'number' || !spec.unit) return null;
  return quantityClass(nameTokens(numberSpecText(key, spec.unit, v)).find((t) => /\d/.test(t)) ?? '');
}

/** The checks of the file header. attrs must already be checked (checkAttrs). */
export function checkCanonical(source: CanonicalSource, category: string, attrs: Record<string, unknown>): CanonicalCheck {
  const parts = canonicalParts(category, attrs);
  if (parts.length === 0) return { ok: false, reason: 'no product line or model' };
  const canonical = canonicalName(category, attrs)!;
  const readable = parts.map(([, t]) => t).join(' ');
  const canonToks = nameTokens(readable);
  const canonSet = new Set(canonToks);
  const titleToks = nameTokens(source.title);
  const problems: string[] = [];

  // brand: kept when it names the maker, and never one the shop data does not have
  const pattern = PATTERNS[category] ?? [];
  if (pattern.some((p) => p.includes('brand'))) {
    const status = source.brandStatus ?? basicBrandStatus(source.brand);
    const brand = text(attrs.brand);
    if (!brand) {
      if (status === 'reliable') problems.push(`brand ${source.brand} missing`);
    } else {
      if (status === 'reliable' && source.brand && !keepsBrand(canonToks, source.brand, titleToks)) problems.push(`brand ${source.brand} missing`);
      if (!hasBrand(titleToks, brand) && !(source.brand && compact(source.brand) === compact(brand))) problems.push(`brand ${brand} not in the shop data`);
    }
  }

  // the title's codes, numbers and distinguishing words (CPU, GPU and OS names may move to their fields)
  // a spaced + joins a bundle (checked below), it is not the model word Plus
  const required = nameTokens(requiredText(stripNoise(prep(source.title)), attrs).replace(/(^|\s)\+(?=\s|$)/g, '$1 '));
  const moneyNumbers = new Set(moneyValues(source.title).map((m) => Number(m.replace(/^\D+/, ''))));
  const titlePacks = packCounts(source.title, { pieces: false });
  // every number field of the listing in its unit class, to tell which field a quantity of the title is
  const assigned = Object.keys(attrs)
    .map((k) => fieldClassValue(category, k, attrs[k]))
    .filter((q): q is { cls: string; value: number } => q !== null);
  const sizes = new Set((Array.isArray(attrs.sizes) ? attrs.sizes : []).flatMap((x) => (typeof x === 'string' ? nameTokens(x) : [])));
  const classes = patternClasses(category);
  const lost = new Set<string>();
  const missingFields = new Set<string>();
  required.forEach((t, i) => {
    if (NAME_WORDS.has(t) || AUDIENCE_WORDS.has(t)) {
      const sizeWord = (t === 'xl' || t === 'xs') && (sizes.has(t) || required.some((x) => x !== t && SIZE_TOKENS.has(x)));
      const packWord = (t === 'pack' || titlePacks.some((p) => p.word === t)) && finite(attrs.pack_count);
      const bundleWord = t === 'bundle' && text(attrs.bundle) !== null;
      if (!canonSet.has(t) && !sizeWord && !packWord && !bundleWord) lost.add(t);
      return;
    }
    if (!/\d/.test(t) || BARCODE.test(t) || required[i - 1] === 'size' || sizes.has(t)) return;
    // the number of a value with a currency is checked as that value
    if (/^\d+(?:\.\d+)?$/.test(t) && moneyNumbers.has(Number(t))) return;
    const q = quantityClass(t);
    if (q) {
      const fields = classes.get(q.cls);
      if (!fields) return;
      // given by another field (the RAM of a phone, whose pattern has the storage only): not the pattern's
      if (assigned.some((a) => a.cls === q.cls && a.value === q.value)) return;
      // the title names a storage, volume, ... that the pattern has a field for: the field must be there
      if (!fields.some((k) => attrs[k] !== undefined && attrs[k] !== null)) for (const k of fields) missingFields.add(k);
      return;
    }
    if (/^\d+(?:\.\d+)?$/.test(t)) {
      if (!canonSet.has(t)) lost.add(t);
      return;
    }
    // a code survives as a token, as adjacent tokens, or inside a longer code (Q60D in QE55Q60D)
    if (isCode(t) && !inRun(canonToks, t) && !(t.length >= 3 && canonToks.some((c) => c.includes(t)))) lost.add(t);
  });
  if (lost.size > 0) problems.push(`lost tokens: ${[...lost].join(', ')}`);
  if (missingFields.size > 0) problems.push(`no field for the title's ${[...missingFields].join(', ')}`);

  const canonConditions = new Set(conditions(readable));
  const lostConditions = conditions(source.title).filter((c) => !canonConditions.has(c));
  if (lostConditions.length > 0) problems.push(`condition lost: ${lostConditions.join(', ')}`);
  const canonMoney = new Set(moneyValues(readable));
  const lostMoney = moneyValues(source.title).filter((m) => !canonMoney.has(m));
  if (lostMoney.length > 0) problems.push(`currency value lost: ${lostMoney.join(', ')}`);
  const lostPacks = packCounts(source.title, { pieces: false }).filter((p) => !canonSet.has(String(p.n)) && !(p.word !== null && canonSet.has(p.word)));
  if (lostPacks.length > 0) problems.push(`pack size lost: ${lostPacks.map((p) => p.n).join(', ')}`);
  const titleText = prep(source.title);
  if (BUNDLE.some((re) => re.test(titleText)) && !text(attrs.bundle)) problems.push('bundle lost');
  if (/\brefills?\b/.test(titleText) && attrs.refill !== 'yes' && !canonSet.has('refill')) problems.push('refill lost');

  // no number the shop data does not have (a guessed storage, a model number from memory)
  const dataText = [source.title, ...(source.variantTitles ?? []), source.mpn ?? ''].join(' \n ');
  const dataToks = nameTokens(dataText);
  const dataQty = dataToks.map(quantityClass).filter((q): q is { cls: string; value: number } => q !== null);
  const dataNumbers = new Set(dataToks.flatMap((t) => (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)));
  // a pack the title says in words (Twin Pack is 2)
  for (const p of titlePacks) dataNumbers.add(p.n);
  const invented = new Set<string>();
  for (const [key, t] of parts) {
    if (key === 'face_value') continue;
    const fieldQ = fieldClassValue(category, key, attrs[key]);
    if (fieldQ) {
      if (!dataQty.some((q) => q.cls === fieldQ.cls && q.value === fieldQ.value)) invented.add(nameTokens(t).find((x) => /\d/.test(x)) ?? t);
      continue;
    }
    for (const tok of nameTokens(t)) {
      if (!/\d/.test(tok)) continue;
      const known = inRun(dataToks, tok) || dataToks.some((d) => d.includes(tok)) || (tok.match(/\d+(?:\.\d+)?/g) ?? []).every((n) => dataNumbers.has(Number(n)));
      if (!known) invented.add(tok);
    }
  }
  if (invented.size > 0) problems.push(`not in the shop data: ${[...invented].join(', ')}`);

  return problems.length > 0 ? { ok: false, reason: problems.join('; ') } : { ok: true, canonical };
}
