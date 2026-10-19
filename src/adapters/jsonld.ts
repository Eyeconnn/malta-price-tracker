import type { CheerioAPI } from 'cheerio';
import { cleanGtin, emptyToNull, toCents } from '../util/normalise.js';

export interface LdProduct {
  name: string | null;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  brand: string | null;
  image: string | null;
  category: string | null;
  price_cents: number | null;
  in_stock: boolean | null;
  url: string | null;
}

function first<T>(v: T | T[] | undefined): T | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function textOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return emptyToNull(String(v));
  if (typeof v === 'object' && 'name' in (v as object)) return textOf((v as { name: unknown }).name);
  return null;
}

/** All schema.org Product objects in the page's JSON-LD (including inside @graph and ItemPage). */
export function jsonLdProducts($: CheerioAPI): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const o = n as Record<string, unknown>;
    const type = o['@type'];
    if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) out.push(o);
    if (o['@graph']) walk(o['@graph']);
    if (o.mainEntity) walk(o.mainEntity);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walk(JSON.parse($(el).text()));
    } catch {
      // broken JSON-LD is common; ignore it
    }
  });
  return out;
}

export function parseLdProduct(o: Record<string, unknown>): LdProduct {
  const offers = first(o.offers as Record<string, unknown> | Record<string, unknown>[] | undefined) ?? {};
  const price = offers.price ?? offers.lowPrice ?? first(offers.priceSpecification as Record<string, unknown>[] | undefined)?.price;
  const availability = textOf(offers.availability);
  const gtin = ['gtin13', 'gtin', 'gtin12', 'gtin14', 'gtin8'].map((k) => cleanGtin(o[k] ?? offers[k])).find(Boolean) ?? null;
  const image = first(o.image as unknown);
  return {
    name: textOf(o.name),
    sku: textOf(o.sku),
    gtin,
    mpn: textOf(o.mpn),
    brand: textOf(o.brand),
    image: typeof image === 'string' ? image : textOf((image as { url?: unknown })?.url),
    category: textOf(o.category),
    price_cents: toCents(price as string | number | undefined),
    in_stock: availability ? /InStock|LimitedAvailability|PreOrder|BackOrder/i.test(availability) : null,
    url: textOf(o.url ?? offers.url),
  };
}

export function firstLdProduct($: CheerioAPI): LdProduct | null {
  const all = jsonLdProducts($);
  return all.length ? parseLdProduct(all[0]!) : null;
}
