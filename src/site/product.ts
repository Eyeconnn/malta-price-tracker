// The product that one or more shops' listings form on the public site (design Part 3): its clean name, the specs
// and attributes the listings agree on, and the variant options. Pure, used by the Worker's read API.
import raw from '../../config/attribute-schemas.json' with { type: 'json' };
import { compact } from '../names/text.js';
import { nameKey, nameTokens, numberSpecText, specParts } from './identity.js';

/** One shop's listing as the product helpers read it (site_products row with its product_names row). */
export type Listing = {
  shopSlug: string;
  /** the shop's own title */
  title: string;
  /** the accepted clean name, null without one */
  displayName: string | null;
  /** the category the clean name and attributes were made for */
  category: string | null;
  attrs: Record<string, unknown> | null;
};

type Attrs = Record<string, unknown>;

/** A value compared across listings: numbers as they are, text case-insensitively and without punctuation. */
const sameKey = (v: unknown): string => (typeof v === 'number' ? `n${v}` : typeof v === 'string' ? `s${compact(v)}` : `x${JSON.stringify(v)}`);

/**
 * The attributes several listings agree on: a value every listing that has it gives the same; lists (colours,
 * sizes) are joined without repeats; a key whose listings disagree is left out.
 */
export function agreedAttrs(list: (Attrs | null)[]): Attrs {
  const out: Attrs = {};
  const conflict = new Set<string>();
  for (const attrs of list) {
    if (!attrs) continue;
    for (const [k, v] of Object.entries(attrs)) {
      if (conflict.has(k) || v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        const prev = Array.isArray(out[k]) ? (out[k] as unknown[]) : [];
        const seen = new Set(prev.map(sameKey));
        const merged = [...prev];
        for (const x of v) {
          if (!seen.has(sameKey(x))) {
            seen.add(sameKey(x));
            merged.push(typeof x === 'string' ? x.toLowerCase() : x);
          }
        }
        out[k] = merged.map((x) => (typeof x === 'string' ? x.toLowerCase() : x));
      } else if (!Object.hasOwn(out, k)) out[k] = v;
      else if (sameKey(out[k]) !== sameKey(v)) {
        conflict.add(k);
        delete out[k];
      }
    }
  }
  return out;
}

/**
 * The product's clean name (design Part 2 rule 5): the clean name most shops agree on (by nameKey), written as most
 * of those listings write it, the shortest on a tie; the fallback (the best hit's shop title) when no listing has
 * one. category and attrs come from the listings with that name (agreedAttrs).
 */
export function productName(listings: Listing[], fallback: string): { name: string; category: string | null; attrs: Attrs } {
  const byKey = new Map<string, { shops: Set<string>; spellings: Map<string, number>; listings: Listing[] }>();
  for (const l of listings) {
    if (!l.displayName) continue;
    const key = nameKey(l.displayName);
    if (key === '') continue;
    const e = byKey.get(key) ?? { shops: new Set<string>(), spellings: new Map<string, number>(), listings: [] };
    e.shops.add(l.shopSlug);
    e.spellings.set(l.displayName, (e.spellings.get(l.displayName) ?? 0) + 1);
    e.listings.push(l);
    byKey.set(key, e);
  }
  const shortest = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  let best: { shops: Set<string>; spellings: Map<string, number>; listings: Listing[]; name: string } | null = null;
  for (const e of byKey.values()) {
    const name = [...e.spellings.entries()].sort((a, b) => b[1] - a[1] || shortest(a[0], b[0]))[0][0];
    if (!best || e.shops.size > best.shops.size || (e.shops.size === best.shops.size && shortest(name, best.name) < 0)) best = { ...e, name };
  }
  if (!best) return { name: fallback, category: null, attrs: {} };
  const category = best.listings.find((l) => l.category)?.category ?? null;
  return { name: best.name, category, attrs: agreedAttrs(best.listings.map((l) => l.attrs)) };
}

type RawSpec = { type?: string; unit?: string };
const SCHEMAS = (raw as { categories: Record<string, Record<string, RawSpec | unknown>> }).categories;

/** Plain labels for attribute keys; others are written from the key ("energy_class" is "Energy class"). */
const LABELS: Record<string, string> = {
  model: 'Model',
  screen_in: 'Screen',
  cpu: 'Processor',
  ram_gb: 'Memory',
  storage_gb: 'Storage',
  storage_type: 'Storage type',
  gpu: 'Graphics',
  os: 'Operating system',
  colour: 'Colours',
  device_type: 'Type',
  product_type: 'Type',
  appliance_type: 'Type',
  drink_type: 'Type',
  network: 'Network',
  sim: 'SIM',
  resolution: 'Resolution',
  panel: 'Panel',
  smart_os: 'Smart TV system',
  hdr: 'HDR',
  refresh_hz: 'Refresh rate',
  power_w: 'Power',
  wireless: 'Wireless',
  platform: 'Platform',
  edition: 'Edition',
  capacity_l: 'Capacity',
  capacity_kg: 'Load',
  energy_class: 'Energy class',
  noise_db: 'Noise',
  width_cm: 'Width',
  height_cm: 'Height',
  depth_cm: 'Depth',
  diameter_cm: 'Diameter',
  theme: 'Theme',
  age_min_years: 'From age',
  age_min_months: 'From age',
  age_max_months: 'Up to age',
  max_weight_kg: 'Maximum weight',
  pieces: 'Pieces',
  sizes: 'Sizes',
  pack_count: 'Pack',
  count: 'Pack',
  gender: 'For',
  size_system: 'Size system',
  material: 'Material',
  fit: 'Fit',
  volume_ml: 'Volume',
  weight_g: 'Weight',
  weight_kg: 'Weight',
  spf: 'SPF',
  scent: 'Scent',
  sport: 'Sport',
  wheel_size_in: 'Wheel size',
  style: 'Style',
  abv_pct: 'Alcohol',
  vintage: 'Vintage',
  country: 'Country',
  grape: 'Grape',
};

const label = (key: string) => LABELS[key] ?? (key.charAt(0).toUpperCase() + key.slice(1)).replace(/_/g, ' ');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Text a shop or the normaliser wrote, shown only when short and plainly text (React renders it as text anyway). */
const plain = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 120 && !/[<>]/.test(v);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function numberValue(key: string, unit: string | undefined, n: number): string {
  switch (unit) {
    case 'GB':
      return key === 'ram_gb' ? `${n}GB` : numberSpecText(key, unit, n);
    case 'items':
      return `${n} items`;
    case '%':
      return `${n}%`;
    case 'years':
    case 'months':
      return `${n} ${unit}`;
    default:
      return numberSpecText(key, unit, n);
  }
}

/** The attributes worth showing, in the category's order: label and value text. The brand is shown on its own. */
export function attributeList(category: string | null, attrs: Attrs | null): { key: string; label: string; value: string }[] {
  if (category === null || !attrs || !Object.hasOwn(SCHEMAS, category)) return [];
  const out: { key: string; label: string; value: string }[] = [];
  for (const [key, specRaw] of Object.entries(SCHEMAS[category])) {
    if (key === 'identity' || key === 'brand' || !Object.hasOwn(attrs, key)) continue;
    const spec = specRaw as RawSpec;
    const v = attrs[key];
    let value: string | null = null;
    if (spec.type === 'number') value = finite(v) && v >= 0 ? numberValue(key, spec.unit, v) : null;
    else if (Array.isArray(v)) {
      const items = v.filter(plain).map((x) => upperFirst(x.trim()));
      value = items.length > 0 ? items.join(', ') : null;
    } else if (plain(v)) value = v.trim();
    if (value !== null) out.push({ key, label: label(key), value });
  }
  return out;
}

/** Words that only name the kind of spec ("1TB SSD", "12GB RAM"). */
const SPEC_WORDS = new Set(['ssd', 'hdd', 'emmc', 'ram', 'rom', 'storage', 'memory']);

/**
 * A listing's variant option from its clean variant label: the parts that only repeat the product's identity specs
 * ("512GB, 12GB" of "512GB, 12GB, Grey") are dropped, so what is left is the option (Grey). Null when nothing is left.
 */
export function optionLabel(variantLabel: string | null, category: string | null, attrs: Attrs | null): string | null {
  if (!variantLabel || variantLabel.trim() === '') return null;
  const idTokens = new Set(specParts(category, attrs).flatMap((p) => nameTokens(p.text)));
  const parts = variantLabel
    .split(/\s*,\s*/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .filter((p) => {
      const toks = nameTokens(p);
      const numeric = toks.filter((t) => /\d/.test(t));
      const onlySpec = numeric.length > 0 && numeric.every((t) => idTokens.has(t)) && toks.every((t) => /\d/.test(t) || SPEC_WORDS.has(t) || idTokens.has(t));
      return !onlySpec;
    });
  return parts.length > 0 ? parts.join(', ') : null;
}
