// Detects whether a product is marked for Black Friday on the shop's site, from its tags,
// categories, collections, badge and title. Markers that name a past year are "stale".
import type { NormalisedRecord } from '../types.js';

export type BfStatus = 'marked' | 'excluded' | 'stale';

export interface BfResult {
  status: BfStatus;
  marker: string;
}

const CAMPAIGN_YEAR = 2026;

const EXCLUDED = /not\s*inc(l(uded)?)?\s*(in\s*)?(bf|black\s*friday)|not\s*in\s*(bf|black\s*friday)|excl(uded|ude)?\s*(from\s*)?(bf|black\s*friday)|no\s*bf\b/i;
const TEXT = /black[\s_.-]*friday|black[\s_-]*week|cyber[\s_-]*monday|\bbfcm\b/i;
// codes like BF26, BF-2026, BFCM25, CM2025
const CODE = /^(bf|bfcm|cm)[\s_-]?(\d{2}|\d{4})$/i;
// a standalone "BF" word, e.g. "30% BF", "BF Sale"
const WORD = /(^|[^a-z0-9])bf([^a-z0-9]|$)/i;

function yearOf(s: string): number | null {
  const four = /20\d\d/.exec(s);
  if (four) return Number(four[0]);
  const code = CODE.exec(s.trim());
  if (code && code[2]!.length === 2) return 2000 + Number(code[2]);
  if (code && code[2]!.length === 4) return Number(code[2]);
  return null;
}

/** Classifies one piece of text (a tag, category, badge or title). */
export function classify(text: string): BfStatus | null {
  const t = text.trim();
  if (!t) return null;
  if (EXCLUDED.test(t)) {
    // "NOTINCBF25": excluded from a past year's sale says nothing about this year
    const y = yearOf(t) ?? yearOf(t.replace(/^.*?(bf|cm)/i, '$1'));
    return y !== null && y !== CAMPAIGN_YEAR ? 'stale' : 'excluded';
  }
  const isMarker = TEXT.test(t) || CODE.test(t) || WORD.test(t);
  if (!isMarker) return null;
  const year = yearOf(t);
  if (year !== null && year !== CAMPAIGN_YEAR) return 'stale';
  return 'marked';
}

/**
 * The product's Black Friday status. "excluded" wins over "marked", which wins over "stale".
 * Shopify collection membership arrives in meta.bf_collection (set by the adapter).
 */
export function detectBlackFriday(r: NormalisedRecord): BfResult | null {
  const sources: [string, string][] = [];
  for (const t of r.tags ?? []) sources.push(['tag', t]);
  if (r.category_path) for (const c of r.category_path.split(/\s*[|>]\s*/)) sources.push(['category', c]);
  const col = r.meta?.bf_collection;
  if (typeof col === 'string') sources.push(['collection', col]);
  if (r.badge_text) sources.push(['badge', r.badge_text]);
  // titles are left out on purpose: "Black Friday Board Game" is a product name, not a sale marker

  let best: BfResult | null = null;
  const rank: Record<BfStatus, number> = { excluded: 3, marked: 2, stale: 1 };
  for (const [kind, text] of sources) {
    const status = classify(text);
    if (!status) continue;
    if (!best || rank[status] > rank[best.status]) best = { status, marker: `${kind}: ${text}`.slice(0, 200) };
  }
  return best;
}
