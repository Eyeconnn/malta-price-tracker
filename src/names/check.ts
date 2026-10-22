// Checks every answer before it is used (design Part 2, rule 6, enforced in code).
//
// Name rule. A clean name is accepted only if it keeps the brand (when the shop gives a real one) and every
// number-bearing and model token of the shop title, counting the name and the variant label together:
// - numbers with a unit (16GB, 512SSD, 1.7L, 15.6") must keep their number in the name or variant label,
//   in any spelling of the unit (512SSD is kept by "512GB" or "512 GB SSD"); units are never converted;
// - codes mixing letters and digits (G6, A515, S24, iPhone15) must survive as a token, or inside the joined name;
// - model words (Pro, Max, Plus, Mini, Ultra, Air, Lite, SE, FE, Neo, Slim, XL, XS, from src/site/matching.ts) must survive;
// - specs may move into attributes instead: codes, model words and bare numbers found in the cpu or gpu attribute
//   (I5, R7, Ultra 7, 155H, RTX4060), and Windows codes (W10, W11P, Win11) when the os attribute is set;
// - letter-only codes such as IRL are not required (they cannot be told apart from shop noise);
// - digit runs of 8 or more (barcodes, SKUs in brackets) may go.
// The name must also be 3 to 140 characters with no HTML, no em dash, and must not be just the variant label.
//
// Attributes: keys outside the category schema, enum values outside the allowed list, numbers that are not finite
// or out of the schema bounds, and text with HTML are dropped one by one (recorded); the rest is kept.
import { MODEL } from '../site/matching.js';
import type { Batch, BatchItem } from './prompt.js';
import type { AttrSpec, CategorySchema } from './schema.js';

export const NAME_MIN = 3;
export const NAME_MAX = 140;
const TEXT_MAX = 120;

const EM_DASH = '\u2014';
const HTML = /[<>]|&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Brand values shops use when there is no brand. */
const PLACEHOLDER_BRANDS = new Set(['generic', 'unbranded', 'nobrand', 'none', 'na', 'other', 'others', 'unknown', 'default', 'oem', 'various']);
const COMPANY_WORDS = new Set(['inc', 'ltd', 'limited', 'co', 'gmbh', 'srl', 'spa', 'llc', 'plc', 'sa', 'ag', 'bv']);

const UNITS = new Set(
  'gb tb mb kb ssd hdd emmc w kw v mah wh l ml cl dl kg g mg mm cm m km in inch hz khz mhz ghz mp k p x pcs pc pack db'.split(' '),
);
const QUANTITY = /^(\d+(?:\.\d+)?)([a-z]*)$/;
const OS_CODE = /^w(?:in)?(?:7|8|10|11)[a-z]{0,2}$/;
const BARCODE = /^\d{8,}$/;

/** Lower-case tokens; decimals kept ("15,6" and "15.6" are 15.6), everything else that is not a letter or digit splits. */
export function nameTokens(s: string): string[] {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(\d),(\d)/g, '$1.$2')
    .split(/[^\p{L}\p{N}.]+/u)
    .flatMap((t) => {
      const u = t.replace(/^\.+|\.+$/g, '');
      return QUANTITY.test(u) ? [u] : u.split('.');
    })
    .filter((t) => t !== '');
}

const compact = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const hasDigit = (t: string) => /[0-9]/.test(t);

function numberOf(t: string): string | null {
  const m = QUANTITY.exec(t);
  if (!m || (m[2] !== '' && !UNITS.has(m[2]))) return null;
  return String(Number.parseFloat(m[1]));
}

function brandKept(brand: string | null, name: string): boolean | null {
  if (!brand) return null;
  const b = compact(brand);
  if (b === '' || PLACEHOLDER_BRANDS.has(b)) return null;
  if (compact(name).includes(b)) return true;
  const words = nameTokens(brand).filter((w) => !COMPANY_WORDS.has(w));
  const have = new Set(nameTokens(name));
  return words.length > 0 && words.every((w) => have.has(w));
}

export type NameAnswer = { display_name: string; variant_label: string | null; attrs: Record<string, unknown> };
export type NameCheck = { ok: true } | { ok: false; reason: string };

function textProblem(s: string): string | null {
  if (HTML.test(s)) return 'contains HTML';
  if (s.includes(EM_DASH)) return 'contains an em dash';
  if (CONTROL.test(s)) return 'contains control characters';
  return null;
}

/** The safety rule for one clean name (see the top of this file). attrs must already be checked. */
export function checkName(source: { title: string; brand: string | null }, a: NameAnswer): NameCheck {
  const name = a.display_name.trim();
  const label = (a.variant_label ?? '').trim();
  if (name.length < NAME_MIN) return { ok: false, reason: 'name too short' };
  if (name.length > NAME_MAX) return { ok: false, reason: 'name too long' };
  const problem = textProblem(name) ?? (label ? textProblem(label) : null);
  if (problem) return { ok: false, reason: problem };
  if (!/[\p{L}\p{N}]/u.test(name)) return { ok: false, reason: 'name has no letters or digits' };
  if (label) {
    const labelTokens = new Set(nameTokens(label));
    if (compact(name) === compact(label) || nameTokens(name).every((t) => labelTokens.has(t))) {
      return { ok: false, reason: 'name is only the variant label' };
    }
  }

  if (brandKept(source.brand, name) === false) return { ok: false, reason: `brand ${source.brand} missing` };

  const kept = `${name} ${label}`;
  const keptTokens = new Set(nameTokens(kept));
  const keptCompact = compact(kept);
  const keptNumbers = new Set<string>();
  for (const t of keptTokens) {
    const n = numberOf(t);
    if (n !== null) keptNumbers.add(n);
  }
  const specText = ['cpu', 'gpu'].map((k) => a.attrs[k]).filter((v): v is string => typeof v === 'string').join(' ');
  const specTokens = new Set(nameTokens(specText));
  const hasOs = typeof a.attrs.os === 'string' && a.attrs.os !== '';

  const lost: string[] = [];
  for (const t of new Set(nameTokens(source.title))) {
    if (keptTokens.has(t)) continue;
    if (MODEL.has(t)) {
      if (!specTokens.has(t)) lost.push(t);
      continue;
    }
    if (!hasDigit(t) || BARCODE.test(t)) continue;
    const n = numberOf(t);
    if (n !== null) {
      // a bare number may be part of a processor name (Ryzen 7); a number with a unit must stay in the name
      if (keptNumbers.has(n) || (QUANTITY.exec(t)![2] === '' && specTokens.has(t))) continue;
      lost.push(t);
      continue;
    }
    if (OS_CODE.test(t)) {
      if (!hasOs && !keptCompact.includes(t)) lost.push(t);
      continue;
    }
    if (!keptCompact.includes(t) && !specTokens.has(t)) lost.push(t);
  }
  if (lost.length > 0) return { ok: false, reason: `lost tokens: ${lost.join(', ')}` };
  return { ok: true };
}

type ValueCheck = { ok: true; value: string | number } | { ok: false; why: string };

function checkValue(spec: AttrSpec, v: unknown): ValueCheck {
  if (spec.type === 'number') {
    const n = typeof v === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(v) ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, why: 'not a number' };
    if (n < spec.min! || n > spec.max!) return { ok: false, why: 'number out of range' };
    return { ok: true, value: n };
  }
  if (spec.type === 'enum') {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : null;
    const hit = s === null ? undefined : spec.values!.find((x) => x.toLowerCase() === s);
    return hit === undefined ? { ok: false, why: 'not an allowed value' } : { ok: true, value: hit };
  }
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : null;
  if (s === null || s === '' || s.length > TEXT_MAX || textProblem(s) !== null) return { ok: false, why: 'bad text' };
  return { ok: true, value: s };
}

export type AttrCheck = { attrs: Record<string, unknown>; dropped: string[] };

export function checkAttrs(raw: unknown, schema: CategorySchema): AttrCheck {
  const attrs: Record<string, unknown> = {};
  const dropped: string[] = [];
  if (raw === null || raw === undefined) return { attrs, dropped };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { attrs, dropped: ['attrs (not an object)'] };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    const spec = Object.hasOwn(schema, key) ? schema[key] : undefined;
    if (!spec) {
      dropped.push(`${key} (not in schema)`);
      continue;
    }
    if (spec.multi) {
      const list = Array.isArray(value) ? value : [value];
      const good: (string | number)[] = [];
      let firstWhy: string | null = null;
      for (const item of list) {
        const r = checkValue(spec, item);
        if (r.ok) {
          if (!good.includes(r.value)) good.push(r.value);
        } else firstWhy ??= r.why;
      }
      if (good.length > 0) attrs[key] = good;
      else if (firstWhy !== null) dropped.push(`${key} (${firstWhy})`);
      continue;
    }
    const r = checkValue(spec, Array.isArray(value) && value.length === 1 ? value[0] : value);
    if (r.ok) attrs[key] = r.value;
    else dropped.push(`${key} (${r.why})`);
  }
  return { attrs, dropped };
}

export type ItemResult = {
  item: BatchItem;
  status: 'ok' | 'rejected';
  reason: string | null;
  /** null when rejected: the site keeps the shop title */
  displayName: string | null;
  variantLabel: string | null;
  attrs: Record<string, unknown>;
  dropped: string[];
  /** what Claude proposed, for the report */
  proposedName: string | null;
};

type RawAnswer = { key?: unknown; display_name?: unknown; variant_label?: unknown; attrs?: unknown };

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Checks one batch answer. A missing or unreadable item is rejected; answers with keys not in the batch are listed. */
export function checkBatch(batch: Batch, output: unknown, schema: CategorySchema): { results: ItemResult[]; unknownKeys: string[] } {
  const answers = (output as { items?: unknown } | null)?.items;
  const list: RawAnswer[] = Array.isArray(answers) ? answers.filter((a): a is RawAnswer => !!a && typeof a === 'object') : [];
  const keys = new Set(batch.items.map((i) => i.key));
  const byKey = new Map<string, RawAnswer>();
  const unknownKeys: string[] = [];
  for (const a of list) {
    const k = String(a.key);
    if (!keys.has(k)) unknownKeys.push(k);
    else if (!byKey.has(k)) byKey.set(k, a);
  }

  const results = batch.items.map((item): ItemResult => {
    const reject = (reason: string, proposedName: string | null = null, dropped: string[] = []): ItemResult => ({
      item, status: 'rejected', reason, displayName: null, variantLabel: null, attrs: {}, dropped, proposedName,
    });
    const a = byKey.get(item.key);
    if (!a) return reject('missing from answer');
    if (typeof a.display_name !== 'string') return reject('no display name');
    const name = tidy(a.display_name);
    const label = typeof a.variant_label === 'string' && a.variant_label.trim() !== '' ? tidy(a.variant_label) : null;
    if (label !== null && label.length > NAME_MAX) return reject('variant label too long', name);
    const { attrs, dropped } = checkAttrs(a.attrs, schema);
    const check = checkName({ title: item.group.title, brand: item.group.brand }, { display_name: name, variant_label: label, attrs });
    if (!check.ok) return reject(check.reason, name, dropped);
    return { item, status: 'ok', reason: null, displayName: name, variantLabel: label, attrs, dropped, proposedName: name };
  });
  return { results, unknownKeys };
}
