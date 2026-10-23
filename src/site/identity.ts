// What makes two shops' listings one product by name (design Part 3, owner decision "name + specs"), and the
// short specs summary shown after a clean name. Pure, so the site build (Node) and the Worker share it.
//
// - nameKey: the clean name with case, accents, trademark signs, spacing, punctuation, UK/US spelling and unit
//   spelling made equal (the normaliser's own text helpers, src/names/text.ts): "Galaxy Tab-S10" = "Galaxy TabS10",
//   "15.6"" = "15.6 inch", "512 SSD" = "512GB". "+" reads as "plus" and "&" as "and", so an S25+ is never an S25.
// - identity: per site category the key specs (config/attribute-schemas.json, "identity"). Two listings are the
//   same product only when every spec both have is equal; a spec on one side only does not block, and a spec with a
//   default counts a missing value as that default (a drink without a pack count is one bottle). Colour and size are
//   variant options and never part of identity.
// - specsSummary: the identity specs a clean name does not already carry ("256GB, 12GB RAM"), for "name · specs".
import raw from '../../config/attribute-schemas.json' with { type: 'json' };
import { compact, inRun, prep, QUANTITY, tokens, UNIT } from '../names/text.js';

export type IdentitySpec = {
  key: string;
  type: 'text' | 'enum' | 'number';
  /** number specs: the attribute's fixed unit (GB, inch, ml, items, ...) */
  unit?: string;
  /** a missing value counts as this one when comparing (never shown) */
  default?: number | string;
};
export type IdentityConfig = Record<string, IdentitySpec[]>;

/** Keys that are variant options, never identity. */
const VARIANT_KEYS = new Set(['colour', 'size', 'sizes']);

type RawEntry = string | { key?: unknown; default?: unknown };
type RawFile = { categories?: Record<string, Record<string, unknown>> };

/** The identity lists of every category, checked against the category's attribute keys. */
export function parseIdentity(file: unknown): IdentityConfig {
  const cats = (file as RawFile).categories ?? {};
  const out: IdentityConfig = {};
  for (const [slug, cat] of Object.entries(cats)) {
    const list = cat.identity as RawEntry[] | undefined;
    if (!Array.isArray(list)) throw new Error(`attribute schemas: ${slug} has no identity list`);
    out[slug] = list.map((entry) => {
      const key = typeof entry === 'string' ? entry : typeof entry?.key === 'string' ? entry.key : '';
      if (VARIANT_KEYS.has(key)) throw new Error(`attribute schemas: ${slug} identity has ${key}, a variant option`);
      const spec = cat[key] as { type?: string; unit?: string; multi?: boolean } | undefined;
      if (key === 'identity' || !spec || typeof spec !== 'object') throw new Error(`attribute schemas: ${slug} identity names unknown key ${key || String(entry)}`);
      const type = spec.type === 'number' || spec.type === 'enum' ? spec.type : 'text';
      const s: IdentitySpec = { key, type };
      if (type === 'number' && spec.unit) s.unit = spec.unit;
      if (typeof entry === 'object' && (typeof entry.default === 'number' || typeof entry.default === 'string')) s.default = entry.default;
      return s;
    });
  }
  return out;
}

export const IDENTITY: IdentityConfig = parseIdentity(raw);

/** The shared colour list of the attribute schemas (lists.colours). */
export const COLOURS: string[] = ((raw as { lists?: { colours?: string[] } }).lists?.colours ?? []).slice();

/** A quantity token in one spelling ("512ssd" and "512.0gb" are "512gb"); other tokens unchanged. */
function unitForm(t: string): string {
  const m = QUANTITY.exec(t);
  if (m && m[2] !== '' && Object.hasOwn(UNIT, m[2])) return `${Number.parseFloat(m[1])}${UNIT[m[2]]}`;
  return t;
}

/** The tokens of a name as nameKey reads them. */
export function nameTokens(name: string): string[] {
  return tokens(prep(name.replace(/\+/g, ' plus ').replace(/&/g, ' and '))).map(unitForm);
}

/**
 * The clean name in one spelling, for comparing names across shops. Tokens are written together (so "Tab S10",
 * "Tab-S10" and "TabS10" agree) except two numbers in a row, which keep a space ("15 1504" is not "151 504").
 */
export function nameKey(name: string): string {
  let out = '';
  for (const t of nameTokens(name)) {
    if (out !== '' && /\d$/.test(out) && /^\d/.test(t)) out += ' ';
    out += t;
  }
  return out;
}

/** Maker words dropped from a text spec, so "Intel Core i5" = "Core i5" and "NVIDIA GeForce RTX 4060" = "RTX 4060". */
const VENDOR_WORDS = new Set(['intel', 'core', 'amd', 'nvidia', 'geforce', 'radeon', 'apple', 'qualcomm', 'mediatek', 'samsung', 'processor', 'cpu', 'gpu', 'graphics']);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function textValue(v: string): string {
  return tokens(prep(v))
    .filter((t) => !VENDOR_WORDS.has(t))
    .join('');
}

function compareValue(spec: IdentitySpec, v: unknown): string | null {
  if (Array.isArray(v)) {
    const parts = [...new Set(v.map((x) => compareValue(spec, x)).filter((x): x is string => x !== null && x !== ''))].sort();
    return parts.length > 0 ? parts.join(',') : null;
  }
  if (spec.type === 'number') return finite(v) ? String(Math.round(v * 100) / 100) : null;
  if (typeof v !== 'string') return null;
  const t = spec.type === 'enum' ? compact(v) : textValue(v);
  return t === '' ? null : t;
}

/** The category's identity specs of a listing, as comparable strings (defaults filled in). */
export function identityValues(category: string | null, attrs: Record<string, unknown> | null, cfg: IdentityConfig = IDENTITY): Record<string, string> {
  const out: Record<string, string> = {};
  if (category === null || !Object.hasOwn(cfg, category)) return out;
  for (const spec of cfg[category]) {
    const v = attrs && Object.hasOwn(attrs, spec.key) ? compareValue(spec, attrs[spec.key]) : null;
    const value = v ?? (spec.default !== undefined ? compareValue(spec, spec.default) : null);
    if (value !== null) out[spec.key] = value;
  }
  return out;
}

/** Every spec present on both sides is equal. */
export function sameIdentity(a: Record<string, string>, b: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(a)) if (Object.hasOwn(b, k) && b[k] !== v) return false;
  return true;
}

const num = (n: number) => String(Math.round(n * 100) / 100);

/** How a number spec is written, and the name tokens that mean the name already has it. */
function numberText(key: string, unit: string | undefined, n: number): { text: string; present: (toks: string[]) => boolean } {
  const has = (...forms: string[]) => (toks: string[]) => forms.some((f) => toks.includes(f));
  const after = (word: string[]) => (toks: string[]) => toks.some((t, i) => t === num(n) && word.includes(toks[i + 1] ?? ''));
  switch (unit) {
    case 'GB':
      if (key === 'ram_gb') return { text: `${num(n)}GB RAM`, present: has(`${num(n)}gb`) };
      return n >= 1024 && n % 1024 === 0
        ? { text: `${num(n / 1024)}TB`, present: has(`${num(n / 1024)}tb`, `${num(n)}gb`) }
        : { text: `${num(n)}GB`, present: has(`${num(n)}gb`) };
    case 'inch':
      return { text: `${num(n)}"`, present: has(`${num(n)}in`) };
    case 'ml':
      return { text: `${num(n)}ml`, present: has(`${num(n)}ml`, `${num(n / 10)}cl`, `${num(n / 1000)}l`) };
    case 'items':
      return {
        text: `pack of ${num(n)}`,
        present: (t) => has(`${num(n)}x`, `${num(n)}pcs`)(t) || after(['pack', 'pk', 'bottles', 'cans', 'pieces'])(t) || t.some((x, i) => x === 'of' && t[i + 1] === num(n)),
      };
    case 'pieces':
      return { text: `${num(n)} pieces`, present: (t) => has(`${num(n)}pcs`)(t) || after(['pieces', 'piece', 'pcs', 'pc'])(t) };
    case 'year':
      return { text: num(n), present: has(num(n)) };
    case 'SPF':
      return { text: `SPF ${num(n)}`, present: (t) => has(`spf${num(n)}`)(t) || t.some((x, i) => x === 'spf' && t[i + 1] === num(n)) };
    case undefined:
      return { text: num(n), present: has(num(n)) };
    default: {
      const u = unit.toLowerCase();
      return { text: `${num(n)}${unit}`, present: has(`${num(n)}${Object.hasOwn(UNIT, u) ? UNIT[u] : u}`) };
    }
  }
}

/**
 * The identity specs the clean name does not already carry, in the category's order, e.g. "512GB, 12GB RAM"
 * (the name may have moved storage into the attributes). Null when there is nothing to add. Defaults are never shown.
 */
export function specsSummary(category: string | null, attrs: Record<string, unknown> | null, name: string, cfg: IdentityConfig = IDENTITY): string | null {
  const toks = nameTokens(name);
  const parts = specParts(category, attrs, cfg)
    .filter((p) => !p.present(toks))
    .map((p) => p.text);
  if (parts.length === 0) return null;
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Each identity spec a listing gives, as written in a summary ("512GB", "12GB RAM"), with its in-name check. */
export function specParts(
  category: string | null,
  attrs: Record<string, unknown> | null,
  cfg: IdentityConfig = IDENTITY,
): { key: string; text: string; present: (nameToks: string[]) => boolean }[] {
  if (category === null || !attrs || !Object.hasOwn(cfg, category)) return [];
  const out: { key: string; text: string; present: (nameToks: string[]) => boolean }[] = [];
  for (const spec of cfg[category]) {
    if (!Object.hasOwn(attrs, spec.key)) continue;
    const v = attrs[spec.key];
    if (spec.type === 'number') {
      if (!finite(v) || v <= 0) continue;
      out.push({ key: spec.key, ...numberText(spec.key, spec.unit, v) });
    } else if (typeof v === 'string' && v.trim() !== '' && v.length <= 60) {
      const target = tokens(prep(v)).map(unitForm).join('');
      if (target !== '') out.push({ key: spec.key, text: v.trim(), present: (toks) => inRun(toks, target) });
    }
  }
  return out;
}

/** A number attribute as the site writes it ("512GB", "1TB", "15.6"", "330ml", "pack of 6"). */
export function numberSpecText(key: string, unit: string | undefined, n: number): string {
  return numberText(key, unit, n).text;
}

export { withSpecs } from './display.js';
