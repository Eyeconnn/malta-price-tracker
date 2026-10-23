// The site build's use of stored judgements (design "Update 23 Oct, afternoon", point 4, JUDGED_MATCHING on): a
// judgement counts only while every member is still listed and the fingerprint of their titles and variant titles
// is the one Claude saw; newest first, each listing belongs to one judgement only; the veto in code runs again on
// today's data, so a better veto applies at once. The result is clusters of site_products ids for assignMatches.
import type postgres from 'postgres';
import { fingerprint, memberRef } from './fingerprint.js';
import { loadVariantTitles } from './load.js';
import { vetoListing } from './settle.js';
import { loadJudgements, type StoredJudgement } from './store.js';
import { applyVeto } from './veto.js';

export type CurrentListing = {
  id: number;
  shopId: number;
  groupKey: string;
  title: string;
  variantTitles: string[];
  brand: string | null;
  category: string;
  categoryPath: string | null;
  gtin: string | null;
  mpn: string | null;
};

export type Resolved = { clusters: number[][]; read: number; used: number; stale: number; vetoed: number };

/** current: today's listings by member ref (shop id and group key). */
export function resolveJudgements(judgements: StoredJudgement[], current: Map<string, CurrentListing>): Resolved {
  const out: Resolved = { clusters: [], read: judgements.length, used: 0, stale: 0, vetoed: 0 };
  const claimed = new Set<string>();
  const order = [...judgements].sort((a, b) => b.judgedAt.getTime() - a.judgedAt.getTime() || b.id - a.id);
  for (const j of order) {
    const refs = j.members.map((m) => memberRef({ shopId: m.shop_id, groupKey: m.group_key }));
    const members = refs.map((r) => current.get(r));
    if (members.some((m) => m === undefined) || fingerprint(members as CurrentListing[]) !== j.fingerprint) {
      out.stale++;
      continue;
    }
    const list = members as CurrentListing[];
    const free = (i: number) => !claimed.has(refs[i]);
    const clusters = (j.verdict.clusters ?? []).map((c) => c.filter((i) => Number.isInteger(i) && i >= 0 && i < list.length && free(i)));
    const veto = applyVeto(list.map(vetoListing), clusters);
    out.used++;
    out.vetoed += veto.vetoed.length;
    for (const c of veto.clusters) out.clusters.push(c.map((i) => list[i].id));
    refs.forEach((r, i) => {
      if (free(i)) claimed.add(r);
    });
  }
  return out;
}

export type BuildRow = { id: number; shopId: number; groupKey: string; title: string; brand: string | null; category: string | null; gtin: string | null; mpn: string | null };

/**
 * The judged clusters for assignCanonicalIds: stored judgements (none before migration 013) resolved against the
 * site_products rows of this build, with the category paths and variant titles of the judged listings.
 */
export async function judgedClusters(sql: postgres.Sql, rows: BuildRow[]): Promise<Resolved> {
  const judgements = await loadJudgements(sql);
  if (judgements.length === 0) return { clusters: [], read: 0, used: 0, stale: 0, vetoed: 0 };
  const byRef = new Map(rows.map((r) => [memberRef(r), r]));
  const wanted = new Map<string, BuildRow>();
  for (const j of judgements) {
    for (const m of j.members) {
      const ref = memberRef({ shopId: m.shop_id, groupKey: m.group_key });
      const r = byRef.get(ref);
      if (r) wanted.set(ref, r);
    }
  }
  const ids = [...wanted.values()].map((r) => r.id);
  const paths = new Map(
    (await sql<{ id: string; category_path: string | null }[]>`
      select sp.id, p.category_path from site_products sp left join products p on p.id = sp.rep_product_id where sp.id = any(${ids}::bigint[])`).map((r) => [Number(r.id), r.category_path]),
  );
  const keys = new Map<number, string[]>();
  for (const r of wanted.values()) keys.set(r.shopId, [...(keys.get(r.shopId) ?? []), r.groupKey]);
  const variants = await loadVariantTitles(sql, keys);
  const current = new Map<string, CurrentListing>();
  for (const [ref, r] of wanted) {
    current.set(ref, {
      id: r.id, shopId: r.shopId, groupKey: r.groupKey, title: r.title, variantTitles: variants.get(ref) ?? [], brand: r.brand,
      category: r.category ?? 'other', categoryPath: paths.get(r.id) ?? null, gtin: r.gtin, mpn: r.mpn,
    });
  }
  return resolveJudgements(judgements, current);
}
