import type { NormalisedRecord, ShopConfig } from '../types.js';

/** "1,299.00", "€ 1.299,00", "69.00", 69 -> cents. Returns null when nothing sensible is found. */
export function toCents(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  let s = String(value).replace(/[^\d.,-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // whichever separator comes last is the decimal separator
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // "12,50" decimal comma, "1,299" thousands comma
    s = /,\d{2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\.(?=.*\.)/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Store API style minor-unit strings ("3790" with minor unit 2) -> cents. */
export function minorToCents(value: unknown, minorUnit = 2): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10 ** (2 - minorUnit));
}

const GTIN_RE = /^\d{8}$|^\d{12,14}$/;

/** Validates a GTIN-8/12/13/14 check digit. */
export function isValidGtin(code: string): boolean {
  if (!GTIN_RE.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  digits.reverse().forEach((d, i) => {
    sum += d * (i % 2 === 0 ? 3 : 1);
  });
  return (10 - (sum % 10)) % 10 === check;
}

export function cleanGtin(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s/g, '');
  if (!/^\d{8,14}$/.test(s)) return null;
  return isValidGtin(s) ? s : null;
}

function codePoint(cp: number, raw: string): string {
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : raw;
}

/** Decodes the HTML entities WordPress leaves in product names. */
export function decodeEntities(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  return s
    .replace(/&#(\d+);/g, (m, n) => codePoint(Number(n), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => codePoint(parseInt(n, 16), m))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export function emptyToNull(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  return t ? t : null;
}

/**
 * Per-shop identifier rules applied after an adapter has produced a record:
 * - sku_is_gtin: numeric 12/13 digit SKUs with a valid check digit are copied into gtin (AtoZ, Eyeland)
 * - mpn_from_sku: regex with one capture group (Digital Zone: PCA-RAZ-RZ0305930100 gives RZ0305930100)
 */
export function applyIdentifierRules(r: NormalisedRecord, cfg: ShopConfig): NormalisedRecord {
  if (!r.gtin && r.sku && cfg.sku_is_gtin) {
    const g = cleanGtin(r.sku);
    if (g && (g.length === 12 || g.length === 13 || g.length === 14 || g.length === 8)) r.gtin = g;
  }
  if (!r.mpn && r.sku && cfg.mpn_from_sku) {
    const m = new RegExp(cfg.mpn_from_sku).exec(r.sku);
    if (m && m[1]) r.mpn = m[1];
  }
  if (r.gtin) r.gtin = cleanGtin(r.gtin);
  return r;
}

export function blankRecord(external_id: string): NormalisedRecord {
  return {
    external_id,
    parent_external_id: null,
    url: null,
    sku: null,
    gtin: null,
    mpn: null,
    brand: null,
    title: null,
    variant_title: null,
    category_path: null,
    tags: [],
    image_url: null,
    shop_created_at: null,
    price_cents: null,
    was_price_cents: null,
    shop_30d_low_cents: null,
    in_stock: null,
    on_sale: null,
    badge_text: null,
  };
}
