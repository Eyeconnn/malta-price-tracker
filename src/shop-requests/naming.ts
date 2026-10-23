// Name and slug for a shop added from the admin area. Pure: the HTML is data, read for two tags only.
import * as cheerio from 'cheerio';
import { NAME_MAX, cleanDisplayName, hostKey } from './address.js';

// second-level labels that belong to the public suffix (com.mt, co.uk, org.mt, ...)
const SECOND_LEVEL = new Set(['com', 'org', 'net', 'co', 'edu', 'gov', 'ac']);
const SLUG_MAX = 40;

function cut(s: string | null): string | null {
  if (!s) return null;
  return s.length > NAME_MAX ? s.slice(0, NAME_MAX).trimEnd() : s;
}

/** The shop's own name from its home page: og:site_name, else <title> without a "Home" part. Max 80 characters. */
export function siteNameFromHtml(html: string): string | null {
  const $ = cheerio.load(html);
  const og = cleanDisplayName($('meta[property="og:site_name"]').attr('content'));
  if (og) return cut(og);
  const title = cleanDisplayName($('title').first().text());
  if (!title) return null;
  // "Home | Shop", "Shop - Home", "Shop \u2013 Plants and pots": the first part that is not "Home"
  const parts = title.split(/\s+[|:\u2013\u2014-]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return cut(title);
  return cut(parts.find((p) => !/^home( ?page)?$/i.test(p)) ?? title);
}

/** A slug from the host: "www.klikk.com.mt" gives "klikk"; a number is added when the slug is taken. */
export function slugFromHost(host: string, taken: Set<string>): string {
  const labels = hostKey(host).split('.');
  if (labels.length > 1) labels.pop();
  if (labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1]!)) labels.pop();
  const base =
    labels
      .join('-')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_MAX)
      .replace(/-+$/, '') || 'shop';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const s = `${base}-${i}`;
    if (!taken.has(s)) return s;
  }
}
