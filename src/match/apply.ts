// The site build's use of stored judgements (design "Update 23 Oct, afternoon", point 4, JUDGED_MATCHING on): a
// judgement counts only while every member is still listed with the title Claude saw and no variant it did not see
// (a variant that vanished keeps it, review I1; a judgement stored without titles needs its fingerprint); newest
// first, each listing belongs to one judgement only (the rest of an older cluster whose other listings a newer
// judgement holds in one cluster follows them, review I4); the veto in code runs again on today's data, so a better
// veto applies at once. The result is clusters of site_products ids for assignMatches.
import type postgres from 'postgres';
import { fingerprint, memberRef, normText } from './fingerprint.js';
import { loadVariantTitles } from './load.js';
import { vetoListing } from './settle.js';
import { loadJudgements, type StoredJudgement } from './store.js';
import { applyVeto, vetoReasons } from './veto.js';

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
  priceCents?: number | null;
};

/**
 * clusters: the judged clusters of two or more after today's veto. groups (for the merge pass, src/match/merge.ts):
 * every cluster with the key of the judgement it came from, also the listings a judgement left alone (clusters of one).
 */
export type Resolved = { clusters: number[][]; read: number; used: number; stale: number; vetoed: number; groups: { key: string; ids: number[] }[] };

/** current: today's listings by member ref (shop id and group key). */
export function resolveJudgements(judgements: StoredJudgement[], current: Map<string, CurrentListing>): Resolved {
  const out: Resolved = { clusters: [], read: judgements.length, used: 0, stale: 0, vetoed: 0, groups: [] };
  const claimed = new Set<string>();
  /** the index in out.clusters of each clustered site_products id, and of each cluster's entry in out.groups */
  const clusterOf = new Map<number, number>();
  const groupOf: number[] = [];
  const byId = new Map([...current.values()].map((l) => [l.id, l]));
  const order = [...judgements].sort((a, b) => b.judgedAt.getTime() - a.judgedAt.getTime() || b.id - a.id);
  for (const j of order) {
    const refs = j.members.map((m) => memberRef({ shopId: m.shop_id, groupKey: m.group_key }));
    const members = refs.map((r) => current.get(r));
    if (members.some((m) => m === undefined)) {
      out.stale++;
      continue;
    }
    const list = members as CurrentListing[];
    // what Claude saw: the same title and no new variant (a variant that vanished keeps the judgement, review I1)
    const unchanged = j.members.every((m, i) => {
      if (m.title === undefined) return fingerprint(list) === j.fingerprint;
      const seen = new Set(m.variants ?? []);
      return normText(list[i].title) === m.title && list[i].variantTitles.map(normText).every((v) => v === '' || seen.has(v));
    });
    if (!unchanged) {
      out.stale++;
      continue;
    }
    const free = (i: number) => !claimed.has(refs[i]);
    const clusters: number[][] = [];
    const inCluster = new Set<number>();
    for (const c of (j.verdict.clusters ?? []).map((c) => c.filter((i) => Number.isInteger(i) && i >= 0 && i < list.length))) {
      const f = c.filter(free);
      // the rest of a cluster whose other listings a newer judgement holds in one cluster follows them there, when
      // the veto agrees (a run that stopped before judging this rest again keeps its match, review I4)
      const held = new Set(c.filter((i) => !free(i)).map((i) => clusterOf.get(list[i].id)));
      if (f.length > 0 && held.size === 1 && !held.has(undefined)) {
        const k = [...held][0]!;
        const others = out.clusters[k].map((id) => byId.get(id)!);
        const joining = f.map((i) => list[i]);
        const ok = joining.every((x, n) => [...others, ...joining.slice(n + 1)].every((y) => vetoReasons(vetoListing(x), vetoListing(y)).length === 0));
        if (ok) {
          for (const x of joining) {
            out.clusters[k].push(x.id);
            out.groups[groupOf[k]].ids.push(x.id);
            clusterOf.set(x.id, k);
          }
          for (const i of f) inCluster.add(i);
          continue;
        }
      }
      clusters.push(f);
    }
    const veto = applyVeto(list.map(vetoListing), clusters);
    out.used++;
    out.vetoed += veto.vetoed.length;
    for (const c of veto.clusters) {
      for (const i of c) clusterOf.set(list[i].id, out.clusters.length);
      groupOf.push(out.groups.length);
      out.clusters.push(c.map((i) => list[i].id));
      out.groups.push({ key: j.key, ids: c.map((i) => list[i].id) });
      for (const i of c) inCluster.add(i);
    }
    refs.forEach((r, i) => {
      if (!free(i)) return;
      claimed.add(r);
      if (!inCluster.has(i)) out.groups.push({ key: j.key, ids: [list[i].id] });
    });
  }
  return out;
}

export type BuildRow = {
  id: number;
  shopId: number;
  groupKey: string;
  title: string;
  brand: string | null;
  category: string | null;
  gtin: string | null;
  mpn: string | null;
  priceCents: number | null;
};

/**
 * The judged clusters for assignCanonicalIds: stored judgements (none before migration 013) resolved against the
 * site_products rows of this build, with the category paths and variant titles of the judged listings.
 */
export async function judgedClusters(sql: postgres.Sql, rows: BuildRow[]): Promise<Resolved> {
  const judgements = await loadJudgements(sql);
  if (judgements.length === 0) return { clusters: [], read: 0, used: 0, stale: 0, vetoed: 0, groups: [] };
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
      category: r.category ?? 'other', categoryPath: paths.get(r.id) ?? null, gtin: r.gtin, mpn: r.mpn, priceCents: r.priceCents,
    });
  }
  return resolveJudgements(judgements, current);
}
