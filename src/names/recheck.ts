// --recheck-stored: the current checks (check.ts) over the names already stored as ok, without a model call, so a
// stricter rule can retire names that it would now reject.
import { checkBatch } from './check.js';
import type { Batch } from './prompt.js';
import type { CategorySchema } from './schema.js';
import type { GroupInput } from './select.js';

export type StoredName = {
  shopId: number;
  groupKey: string;
  category: string | null;
  displayName: string;
  variantLabel: string | null;
  attrs: Record<string, unknown>;
};

export type RecheckResult = {
  /** stored names whose group is still fresh, so they could be checked */
  checked: number;
  failing: { shopId: number; groupKey: string; reason: string }[];
};

/** Checks every stored ok name of a fresh group again with the group's current data and the stored category's schema. */
export function recheckStored(groups: GroupInput[], stored: StoredName[], schemas: Record<string, CategorySchema>): RecheckResult {
  const byKey = new Map(groups.map((g) => [`${g.shopId}|${g.groupKey}`, g]));
  const result: RecheckResult = { checked: 0, failing: [] };
  for (const s of stored) {
    const g = byKey.get(`${s.shopId}|${s.groupKey}`);
    if (!g) continue;
    const category = s.category && schemas[s.category] ? s.category : g.category;
    const schema = schemas[category] ?? schemas.other;
    const batch: Batch = { category, items: [{ key: '1', group: g }] };
    const answer = { items: [{ key: '1', display_name: s.displayName, variant_label: s.variantLabel, attrs: s.attrs }] };
    const [r] = checkBatch(batch, answer, schema).results;
    result.checked++;
    if (r.status === 'rejected') result.failing.push({ shopId: s.shopId, groupKey: s.groupKey, reason: r.reason ?? 'rejected' });
  }
  return result;
}
