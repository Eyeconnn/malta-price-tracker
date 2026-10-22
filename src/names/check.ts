// Checks every answer before it is used (design Part 2, rule 6, enforced in code).
//
// Name rule. A clean name (display_name and variant_label together) is accepted only if:
// - it is 3 to 140 characters with no HTML, no em dash, no control characters and nothing URL- or domain-like
//   (http, www., "shop.com"), and is not just the variant label;
// - it keeps the brand (when the shop gives a real one, not Generic or the like), matched on word boundaries;
// - it invents no words: every word of 3+ letters is in the shop data (title, variant titles, brand, MPN; case and
//   accents ignored) or is a unit word (inch, litre, watt, SSD, ...). No product nouns are allowed in: an added
//   "Laptop" or "Backpack" would hide a wrong category;
// - numbers keep their unit class and count: every number of the title (with its unit, or bare) appears in the name
//   as often as in the title, with the same unit in any spelling (16 GB = 16GB, 15.6" = 15.6 inch, 1,000W = 1000W);
//   a bare number never matches one with a unit (8 is not 8GB), units are never swapped (16GB is not 16TB), and
//   no number appears that the shop data does not have (A5 is not A55);
// - codes mixing letters and digits (G6, A515, iPhone15) survive as a token or as adjacent tokens (iPhone 15), and
//   codes in the name come from the shop data the same way; model words (Pro, Max, Plus, Mini, Ultra, Air, Lite,
//   SE, FE, Neo, Slim, XL, XS from src/site/matching.ts) survive;
// - only CPU and GPU names (i5, i7-1335U, Ryzen 7, R7, Core Ultra 7, Apple M2, Snapdragon, Exynos, Dimensity,
//   Celeron, N100, RTX 4060, GTX, RX 7600, Arc) may leave the name, when the cpu or gpu attribute holds them, and
//   Windows codes (W11P, Win 11, Windows 11 Pro) when the os attribute is set;
// - letter-only codes such as IRL may go, and so may numeric shop noise: barcodes (8+ digits), percent off
//   ("-30%", "20% OFF") and prices with a currency ("EUR 99", "99.99 euro").
//
// Attributes: keys outside the category schema, enum values outside the allowed list, numbers that are not finite
// or out of the schema bounds, and text with HTML or a web address are dropped one by one (recorded); the rest is kept.
import { MODEL } from '../site/matching.js';
import type { Batch, BatchItem } from './prompt.js';
import type { AttrSpec, CategorySchema } from './schema.js';

export const NAME_MIN = 3;
export const NAME_MAX = 140;
const TEXT_MAX = 120;

const EM_DASH = '\u2014';
const HTML = /[<>]|&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const URL_LIKE = /https?:|\bwww\.|[\p{L}\p{N}][\p{L}\p{N}_-]*\.[a-z]{2,}\b/iu;

/** Brand values shops use when there is no brand. */
const PLACEHOLDER_BRANDS = new Set(['generic', 'unbranded', 'nobrand', 'none', 'na', 'other', 'others', 'unknown', 'default', 'oem', 'various']);
const COMPANY_WORDS = new Set(['inc', 'ltd', 'limited', 'co', 'gmbh', 'srl', 'spa', 'llc', 'plc', 'sa', 'ag', 'bv']);

/** Unit spellings to one unit per class. 512SSD means 512GB. */
const UNIT: Record<string, string> = {
  gb: 'gb', ssd: 'gb', hdd: 'gb', emmc: 'gb', gbssd: 'gb', gbhdd: 'gb', gbemmc: 'gb', tb: 'tb', tbssd: 'tb', tbhdd: 'tb', mb: 'mb', kb: 'kb',
  in: 'in', inch: 'in', inches: 'in',
  w: 'w', watt: 'w', watts: 'w', kw: 'kw', v: 'v', mah: 'mah', wh: 'wh',
  l: 'l', ltr: 'l', litre: 'l', liter: 'l', litres: 'l', liters: 'l', ml: 'ml', cl: 'cl', dl: 'dl',
  kg: 'kg', g: 'g', mg: 'mg', mm: 'mm', cm: 'cm', m: 'm', km: 'km',
  hz: 'hz', khz: 'khz', mhz: 'mhz', ghz: 'ghz', mp: 'mp', k: 'k', p: 'p', x: 'x', pcs: 'pcs', pc: 'pcs', db: 'db',
};
/** Words of 3+ letters a name may use without the shop data having them: unit words only. */
const ALPHA_ALLOW = new Set(['inch', 'inches', 'ssd', 'hdd', 'emmc', 'litre', 'liter', 'litres', 'liters', 'ltr', 'watt', 'watts', 'mah', 'ghz', 'mhz', 'khz', 'pcs']);

const QUANTITY = /^(\d+(?:\.\d+)?)([a-z]*)$/;
const BARCODE = /^\d{8,}$/;

/** CPU and GPU names that may move into the cpu or gpu attribute. */
const SPEC_PATTERNS = [
  /\b(?:intel\s*)?(?:core\s*)?i[3579](?:[\s-]*\d{4,5}[a-z]{0,2})?\b/g,
  /\b(?:intel\s*)?(?:core\s*)?ultra\s*[3579](?:[\s-]*\d{3}[a-z]{0,2})?\b/g,
  /\b(?:intel\s*)?core\s*[3579](?:[\s-]*\d{3,4}[a-z]{0,2})?\b/g,
  /\b(?:amd\s*)?ryzen\s*[3579](?:\s*(?:pro\s*)?\d{4}[a-z]{0,2})?\b/g,
  /\br[3579](?:[\s-]*\d{4}[a-z]{0,2})?\b/g,
  /\b(?:apple\s*)?m[1-5](?:\s*(?:pro|max|ultra))?\b/g,
  /\b(?:qualcomm\s*)?snapdragon\s*(?:\d+|x\d*)(?:\s*(?:gen\s*\d|elite|plus))?\b/g,
  /\b(?:samsung\s*)?exynos\s*\d{3,4}\b/g,
  /\b(?:mediatek\s*)?(?:dimensity\s*\d{3,4}|helio\s*[a-z]\d{2,3})\b/g,
  /\b(?:intel\s*)?(?:celeron|pentium)(?:\s*(?:silver|gold))?\s*n?\d{3,4}[a-z]?\b/g,
  /\b(?:intel\s*)?n[1-3]\d{2}\b/g,
  /\b(?:nvidia\s*)?(?:geforce\s*)?(?:rtx|gtx|mx)\s*\d{3,4}(?:\s*(?:ti|super))?\b/g,
  /\b(?:amd\s*)?(?:radeon\s*)?rx\s*\d{3,4}(?:\s*(?:xtx|xt))?\b/g,
  /\b(?:intel\s*)?arc\s*[ab]\d{3}\b/g,
];
const OS_PATTERN = /\bw(?:in(?:dows)?)?\s*(?:7|8|10|11)(?:\s*(?:home|pro|h|p|s))?\b/g;
const VENDOR_WORDS = /\b(?:intel|core|amd|nvidia|geforce|radeon|apple|qualcomm|mediatek|samsung)\b/g;

/** Lower case, accents off, thousands separators and decimal commas read, inch marks written as "in". */
export function prep(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/(\d)\s*(?:"|''|\u2032\u2032|\u2033|\u201d|\u201c)/g, '$1in ');
}

/** Percent off and prices with a currency: shop noise, never required. */
function stripNoise(t: string): string {
  return t
    .replace(/[-+]?\d+(?:\.\d+)?\s*%/g, ' ')
    .replace(/(?:\u20ac|\u00a3|\$|\beuros?\b|\beur\b)\s*\d+(?:\.\d+)?/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*(?:\u20ac|\u00a3|\$|\beuros?\b|\beur\b)/g, ' ');
}

/** Tokens of prepped text; a number followed by a unit word becomes one token ("16 gb" is "16gb"). */
export function tokens(t: string): string[] {
  const raw = t
    .split(/[^\p{L}\p{N}.]+/u)
    .flatMap((x) => {
      const u = x.replace(/^\.+|\.+$/g, '');
      return QUANTITY.test(u) ? [u] : u.split('.');
    })
    .filter((x) => x !== '');
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (/^\d+(?:\.\d+)?$/.test(raw[i]) && i + 1 < raw.length && Object.hasOwn(UNIT, raw[i + 1])) {
      out.push(raw[i] + raw[i + 1]);
      i++;
    } else out.push(raw[i]);
  }
  return out;
}

const hasDigit = (t: string) => /[0-9]/.test(t);
const compact = (s: string) => prep(s).replace(/[^\p{L}\p{N}]+/gu, '');

/** A number with its unit class ("16|gb", "15.6|in", "8|"), or null when the token is not a quantity. */
function quantity(t: string): string | null {
  const m = QUANTITY.exec(t);
  if (!m || (m[2] !== '' && !Object.hasOwn(UNIT, m[2]))) return null;
  return `${Number.parseFloat(m[1])}|${m[2] === '' ? '' : UNIT[m[2]]}`;
}
const isCode = (t: string) => hasDigit(t) && quantity(t) === null;

/** Number atoms of a token: its quantity, or each digit run of a code (iPhone15 gives 15, so "iPhone 15" matches). */
function atoms(t: string): string[] {
  const q = quantity(t);
  if (q !== null) return [q];
  return (t.match(/\d+/g) ?? []).map((d) => `${Number.parseInt(d, 10)}|`);
}

/** Whether target is one token of the list or adjacent tokens written together. */
function inRun(list: string[], target: string): boolean {
  for (let i = 0; i < list.length; i++) {
    let s = '';
    for (let j = i; j < list.length && s.length < target.length; j++) {
      s += list[j];
      if (s === target) return true;
    }
  }
  return false;
}

type Bag = Map<string, { n: number; text: string }>;
function bag(list: string[], skip: (t: string) => boolean = () => false): Bag {
  const b: Bag = new Map();
  for (const t of list) {
    if (skip(t)) continue;
    for (const a of atoms(t)) {
      const e = b.get(a);
      if (e) e.n++;
      else b.set(a, { n: 1, text: t });
    }
  }
  return b;
}

export type NameSource = { title: string; brand: string | null; variantTitles?: string[]; mpn?: string | null };
export type NameAnswer = { display_name: string; variant_label: string | null; attrs: Record<string, unknown> };
export type NameCheck = { ok: true } | { ok: false; reason: string };

function textProblem(s: string): string | null {
  if (HTML.test(s)) return 'contains HTML';
  if (s.includes(EM_DASH)) return 'contains an em dash';
  if (CONTROL.test(s)) return 'contains control characters';
  if (URL_LIKE.test(s)) return 'contains a web address';
  return null;
}

/** The title with the CPU, GPU and OS names removed that the attributes hold. */
function requiredText(title: string, attrs: Record<string, unknown>): string {
  const specText = compact(['cpu', 'gpu'].map((k) => (typeof attrs[k] === 'string' ? attrs[k] : '')).join(' '));
  let t = title;
  if (specText !== '') {
    for (const p of SPEC_PATTERNS) {
      t = t.replace(p, (m) => {
        const core = compact(m.replace(VENDOR_WORDS, ' '));
        return core !== '' && specText.includes(core) ? ' ' : m;
      });
    }
  }
  if (typeof attrs.os === 'string' && attrs.os !== '') t = t.replace(OS_PATTERN, ' ');
  return t;
}

/** The safety rule for one clean name (see the top of this file). attrs must already be checked. */
export function checkName(source: NameSource, a: NameAnswer): NameCheck {
  const name = a.display_name.trim();
  const label = (a.variant_label ?? '').trim();
  if (name.length < NAME_MIN) return { ok: false, reason: 'name too short' };
  if (name.length > NAME_MAX) return { ok: false, reason: 'name too long' };
  const problem = textProblem(name) ?? (label ? textProblem(label) : null);
  if (problem) return { ok: false, reason: problem };
  if (!/[\p{L}\p{N}]/u.test(name)) return { ok: false, reason: 'name has no letters or digits' };

  const nameToks = tokens(prep(name));
  const labelToks = tokens(prep(label));
  if (label) {
    const ls = new Set(labelToks);
    if (compact(name) === compact(label) || nameToks.every((t) => ls.has(t))) return { ok: false, reason: 'name is only the variant label' };
  }

  if (source.brand) {
    const words = tokens(prep(source.brand)).filter((w) => !COMPANY_WORDS.has(w));
    const b = words.join('');
    if (b !== '' && !PLACEHOLDER_BRANDS.has(b) && !inRun(nameToks, b)) return { ok: false, reason: `brand ${source.brand} missing` };
  }

  // the shop data the name may draw on
  const title = stripNoise(prep(source.title));
  const dataLists = [title, ...(source.variantTitles ?? []), source.mpn ?? '', source.brand ?? ''].map((s) => tokens(stripNoise(prep(s))));
  const vocab = new Set<string>();
  for (const list of dataLists) {
    for (const t of list) {
      vocab.add(t);
      for (const run of t.match(/\p{L}+/gu) ?? []) vocab.add(run);
    }
  }
  const kept = [nameToks, labelToks];
  const keptAll = [...nameToks, ...labelToks];
  const keptSet = new Set(keptAll);

  const invented = [...new Set(keptAll.filter((t) => /^\p{L}{3,}$/u.test(t) && !vocab.has(t) && !ALPHA_ALLOW.has(t)))];

  const required = tokens(requiredText(title, a.attrs));
  const lost: string[] = [];
  for (const t of new Set(required)) {
    if (MODEL.has(t) && !keptSet.has(t)) lost.push(t);
    else if (isCode(t) && !BARCODE.test(t) && !kept.some((l) => inRun(l, t))) lost.push(t);
  }
  const newTokens: string[] = [];
  for (const t of new Set(keptAll)) {
    if (isCode(t) && !dataLists.some((l) => inRun(l, t))) newTokens.push(t);
  }

  const need = bag(required, (t) => BARCODE.test(t));
  const allowed: Bag = new Map();
  for (const list of dataLists) for (const [k, v] of bag(list)) allowed.set(k, { n: (allowed.get(k)?.n ?? 0) + v.n, text: v.text });
  const have = bag(keptAll);
  for (const [k, v] of need) if ((have.get(k)?.n ?? 0) < v.n) lost.push(v.text);
  for (const [k, v] of have) if (v.n > (allowed.get(k)?.n ?? 0)) newTokens.push(v.text);

  const parts: string[] = [];
  if (lost.length > 0) parts.push(`lost tokens: ${[...new Set(lost)].join(', ')}`);
  if (newTokens.length > 0) parts.push(`new tokens: ${[...new Set(newTokens)].join(', ')}`);
  if (invented.length > 0) parts.push(`invented words: ${invented.join(', ')}`);
  return parts.length > 0 ? { ok: false, reason: parts.join('; ') } : { ok: true };
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
    const g = item.group;
    const check = checkName({ title: g.title, brand: g.brand, variantTitles: g.variantTitles, mpn: g.mpn }, { display_name: name, variant_label: label, attrs });
    if (!check.ok) return reject(check.reason, name, dropped);
    return { item, status: 'ok', reason: null, displayName: name, variantLabel: label, attrs, dropped, proposedName: name };
  });
  return { results, unknownKeys };
}
