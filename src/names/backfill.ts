// --backfill-canonical without a model call where it can: a name stored as ok keeps its attrs, so its canonical name
// is rebuilt from them and checked against today's shop title (src/names/canonical.ts). Only the groups whose stored
// fields give none (a field missing, or a title word the fields lose), or whose category changed since, go to Claude.
import { checkCanonical } from './canonical.js';
import type { GroupInput } from './select.js';
import type { CanonicalResult } from './store.js';

export type BackfillSplit = {
  /** canonical names built from the stored fields, checked */
  direct: { group: GroupInput; canonicalName: string }[];
  /** the groups that need a model call */
  needModel: GroupInput[];
};

export function splitBackfill(groups: GroupInput[]): BackfillSplit {
  const out: BackfillSplit = { direct: [], needModel: [] };
  for (const g of groups) {
    const attrs = g.storedAttrs;
    // the stored fields belong to the stored category's schema: a recategorised group is named again
    if (!attrs || Object.keys(attrs).length === 0 || (g.storedNameCategory ?? null) !== g.category) {
      out.needModel.push(g);
      continue;
    }
    const c = checkCanonical({ title: g.title, brand: g.brand, brandStatus: g.brandStatus, variantTitles: g.variantTitles, mpn: g.mpn }, g.category, attrs);
    if (c.ok) out.direct.push({ group: g, canonicalName: c.canonical });
    else out.needModel.push(g);
  }
  return out;
}

/**
 * --recheck-canonical (and the first step of --backfill-canonical), no model call: today's rules over the canonical
 * names stored as ok. A name they write otherwise is rewritten; one they reject, or whose group changed category
 * since, is demoted (canonical_status rejected, the reason kept), so it never name-matches. The display name stays.
 */
export function recheckCanonical(groups: GroupInput[]): { checked: number; updates: CanonicalResult[] } {
  const updates: CanonicalResult[] = [];
  let checked = 0;
  for (const g of groups) {
    if (g.storedStatus !== 'ok' || g.storedCanonicalStatus !== 'ok') continue;
    checked++;
    const row = (canonicalName: string | null, reason: string | null): CanonicalResult => ({ shopId: g.shopId, groupKey: g.groupKey, canonicalName, reason });
    if ((g.storedNameCategory ?? null) !== g.category) {
      updates.push(row(null, `recheck: category changed (${g.storedNameCategory ?? 'none'} to ${g.category})`));
      continue;
    }
    const c = checkCanonical({ title: g.title, brand: g.brand, brandStatus: g.brandStatus, variantTitles: g.variantTitles, mpn: g.mpn }, g.category, g.storedAttrs ?? {});
    if (!c.ok) updates.push(row(null, `recheck: ${c.reason}`));
    else if (c.canonical !== g.storedCanonicalName) updates.push(row(c.canonical, null));
  }
  return { checked, updates };
}
