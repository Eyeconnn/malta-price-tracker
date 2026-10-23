// Address rules for the admin "Add shop" page. Pure and dependency free: the Worker (web/worker/admin.ts) and the
// browser form both use it, so a refusal reads the same in both places. The Worker never fetches the address; the
// PC task (pnpm shop-requests) does, through safeFetch, which also blocks private addresses at connection time.

/** Shop categories the form offers (the categories used in shops.seed.json). */
export const SHOP_CATEGORIES = [
  'electronics',
  'gaming',
  'fashion',
  'beauty',
  'health',
  'home',
  'toys',
  'baby',
  'sports',
  'bikes',
  'music',
  'books',
  'jewellery',
  'drinks',
  'travel',
  'other',
] as const;
export type ShopCategory = (typeof SHOP_CATEGORIES)[number];

export const ADDRESS_MAX = 2048;
export const NAME_MAX = 80;

export type AddressProblem = 'empty' | 'too-long' | 'malformed' | 'scheme' | 'credentials' | 'port' | 'ip' | 'host';

export const ADDRESS_PROBLEM_TEXT: Record<AddressProblem, string> = {
  empty: "Enter the shop's web address.",
  'too-long': 'That address is too long.',
  malformed: 'That does not look like a web address. Try something like https://shop.com.mt.',
  scheme: 'Use an address that starts with https:// or http://.',
  credentials: 'Leave out any user name or password.',
  port: 'Use an address without a port number (only 80 and 443 are allowed).',
  ip: "Use the shop's name, not an IP address.",
  host: 'Use a public web address, such as shop.com.mt.',
};

export type ParsedAddress = { ok: true; origin: string; host: string } | { ok: false; problem: AddressProblem };

// top-level names that are never public shops
const RESERVED_TLDS = new Set(['localhost', 'local', 'internal', 'intranet', 'private', 'localdomain', 'lan', 'home', 'corp', 'test', 'example', 'invalid', 'onion', 'arpa']);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
// a last label that is all digits or a hex number makes the whole name an IPv4 address (WHATWG URL rules)
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|\d+)$/i;

/** Lowercased host name without a trailing dot or a leading "www.": how shops and requests are compared. */
export function hostKey(urlOrHost: string): string {
  let host = urlOrHost.trim();
  try {
    host = new URL(host).hostname;
  } catch {
    // already a bare host name
  }
  return host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/**
 * Checks a typed shop address and reduces it to its origin (scheme, host and a non-default port; no path).
 * No scheme typed means https://. International names come back as punycode (the URL parser does that).
 */
export function parseShopAddress(raw: string): ParsedAddress {
  let s = raw.trim();
  if (!s) return { ok: false, problem: 'empty' };
  if (s.length > ADDRESS_MAX) return { ok: false, problem: 'too-long' };
  // control characters or spaces inside an address
  if (/[\u0000- \u007f]/.test(s)) return { ok: false, problem: 'malformed' };
  if (s.startsWith('//')) s = `https:${s}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    // an IPv6 literal the parser refuses (for example with a zone id) is still an IP address
    if (/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?\[/i.test(s)) return { ok: false, problem: 'ip' };
    return { ok: false, problem: 'malformed' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, problem: 'scheme' };
  if (u.username || u.password) return { ok: false, problem: 'credentials' };
  if (u.port !== '' && u.port !== '80' && u.port !== '443') return { ok: false, problem: 'port' };

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, problem: 'malformed' };
  if (host.startsWith('[') || host.includes(':')) return { ok: false, problem: 'ip' };
  const labels = host.split('.');
  if (NUMERIC_LABEL.test(labels[labels.length - 1]!)) return { ok: false, problem: 'ip' };
  if (host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l))) return { ok: false, problem: 'host' };
  const tld = labels[labels.length - 1]!;
  if (!TLD.test(tld) || RESERVED_TLDS.has(tld)) return { ok: false, problem: 'host' };

  const origin = `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
  return { ok: true, origin, host: hostKey(host) };
}

/** A display name as stored: control characters removed, spaces collapsed, trimmed; null when blank. */
export function cleanDisplayName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = raw
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s : null;
}
