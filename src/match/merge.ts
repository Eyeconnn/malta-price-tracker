// The merge pass of pnpm judge-matches (live check 23 Oct: one iPhone 17 Pro 512GB became two judged products and a
// title group, because its candidate group was judged in chunks). After judging, the clusters of different
// judgements that look like one product (same category and brand, equal identity numbers and model words, title
// words in common, and no veto between their shown listings) are judged again together, one listing per cluster.
// Two clusters are merged only when Claude says same and the veto passes for every cross pair of their listings (the
// shown ones and all others). The result is stored as a judgement like the others (key "m...", fingerprint over all
// members): it is newer, so the site build takes its listings from it; the chunk judgements stay for their other
// listings. Pure: the CLI reads and writes.
import { canonText } from '../names/canon-text.js';
import { titleTokens } from '../site/matching.js';
import { MAX_GROUP, toCandidate, type Candidate, type Listing } from './candidates.js';
import { candidateKey, memberRef } from './fingerprint.js';
import { readAnswers, type JudgeBatch } from './judge.js';
import { listingRows, storedMembers, vetoListing, type Settled } from './settle.js';
import type { JudgementRow, StoredJudgement } from './store.js';
import { applyVeto, identityOf, vetoReasons } from './veto.js';

/** A judged cluster (or a listing a judgement left alone) with the key of its judgement (Resolved.groups). */
export type JudgedGroup = { key: string; ids: number[] };
type Cluster = { source: string; members: Listing[] };

export const isMergeKey = (key: string) => key.startsWith('m');

const compact = (s: string | null | undefined) => (s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function mostCommon(values: string[]): string {
  const n = new Map<string, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? '';
}

/** The listing Claude is shown for a cluster: the one whose title says most (longest), then the lowest id. */
export function repOf(members: Listing[]): Listing {
  return [...members].sort((a, b) => b.title.length - a.title.length || a.id - b.id)[0];
}

/** The brand of a cluster: its members' most common brand field, else the first word of its shown title. */
function brandOf(members: Listing[], rep: Listing): string {
  const brands = members.map((m) => compact(m.brand)).filter((b) => b !== '');
  return brands.length > 0 ? mostCommon(brands) : compact(rep.title.split(/\s+/)[0]);
}

type Signature = { category: string; brand: string; numbers: string; models: string; words: Set<string> };

/** What a cluster must share with another to be a merge candidate; null without an identity number. */
function signature(c: Cluster): Signature | null {
  const rep = repOf(c.members);
  const category = mostCommon(c.members.map((m) => m.category));
  const brand = brandOf(c.members, rep);
  const id = identityOf(rep.title, category);
  if (id.numbers.length === 0) return null;
  const brandWords = new Set(titleTokens(c.members.map((m) => m.brand ?? '').join(' ')).concat(brand));
  const words = new Set(c.members.flatMap((m) => titleTokens(m.title)).filter((w) => !/\d/.test(w) && !brandWords.has(w)));
  return { category, brand, numbers: id.numbers.join(','), models: id.models.join(','), words };
}

const overlap = (a: Set<string>, b: Set<string>) => [...a].some((w) => b.has(w));

export type MergeStats = {
  /** clusters (and listings left alone) of current judgements with an identity number */
  clusters: number;
  /** pairs of clusters of different judgements with the same category, brand and identity numbers */
  pairs: number;
  /** of those, pairs with the same model words, title words in common and no veto between their shown listings */
  candidatePairs: number;
};

/**
 * The merge-pass groups of current judged clusters (groups: Resolved.groups of src/match/apply.ts): clusters of
 * different judgements linked by candidate pairs, at most MAX_GROUP clusters per group (a larger set is cut in title
 * order). byId: today's listings.
 */
export function mergeCandidates(groups: JudgedGroup[], byId: Map<number, Listing>): { candidates: Candidate[]; stats: MergeStats } {
  const clusters: (Cluster & { sig: Signature })[] = [];
  for (const g of groups) {
    const members = g.ids.map((id) => byId.get(id)).filter((m): m is Listing => m !== undefined);
    if (members.length === 0) continue;
    const sig = signature({ source: g.key, members });
    if (sig) clusters.push({ source: g.key, members, sig });
  }
  const stats: MergeStats = { clusters: clusters.length, pairs: 0, candidatePairs: 0 };
  const buckets = new Map<string, number[]>();
  clusters.forEach((c, i) => {
    const k = `${c.sig.category}|${c.sig.brand}|${c.sig.numbers}`;
    buckets.set(k, [...(buckets.get(k) ?? []), i]);
  });
  const parent = clusters.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const reps = clusters.map((c) => vetoListing(repOf(c.members)));
  for (const ids of buckets.values()) {
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const a = clusters[ids[x]];
        const b = clusters[ids[y]];
        if (a.source === b.source) continue;
        stats.pairs++;
        if (a.sig.models !== b.sig.models || !overlap(a.sig.words, b.sig.words)) continue;
        if (vetoReasons(reps[ids[x]], reps[ids[y]]).length > 0) continue;
        stats.candidatePairs++;
        const ra = find(ids[x]);
        const rb = find(ids[y]);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
  }
  const comps = new Map<number, Cluster[]>();
  clusters.forEach((c, i) => {
    const r = find(i);
    comps.set(r, [...(comps.get(r) ?? []), c]);
  });
  const candidates: Candidate[] = [];
  for (const comp of comps.values()) {
    if (comp.length < 2) continue;
    const sorted = [...comp].sort((a, b) => canonText(repOf(a.members).title).localeCompare(canonText(repOf(b.members).title)) || repOf(a.members).id - repOf(b.members).id);
    const parts = Math.ceil(sorted.length / MAX_GROUP);
    const size = Math.ceil(sorted.length / parts);
    for (let i = 0; i < sorted.length; i += size) {
      const chunk = sorted.slice(i, i + size);
      if (chunk.length >= 2 && new Set(chunk.map((c) => c.source)).size >= 2) candidates.push(mergeCandidateOf(chunk));
    }
  }
  return { candidates: candidates.sort((a, b) => (a.key < b.key ? -1 : 1)), stats };
}

/** One merge-pass group: every member of the clusters, Claude shown one listing per cluster, the others attached. */
export function mergeCandidateOf(clusters: Cluster[]): Candidate {
  const reps = clusters.map((c) => repOf(c.members));
  const attached = clusters.map((c, i) => c.members.filter((m) => m !== reps[i]));
  const members = clusters.flatMap((c) => c.members);
  const c = toCandidate({ members, reps, attached }, `m${candidateKey(members).slice(1)}`);
  c.merge = { sources: [...new Set(clusters.map((x) => x.source))].sort() };
  return c;
}

/**
 * A judged merge batch: for each group, Claude's clusters of the shown listings; a cluster joins another only when
 * the veto passes for every cross pair of their listings (shown and attached), else it stays as it was. Every valid
 * answer is stored (a "different" answer too, so the pass does not ask again while the clusters stay).
 */
export function settleMergeBatch(batch: JudgeBatch, output: unknown, ctx: { model: string; effort: string | null; batch: number; firstIndex: number }): Settled {
  const answers = readAnswers(batch, output);
  const out: Settled = { rows: [], judgements: [], judged: 0, rejected: 0, matched: 0, vetoes: 0 };
  batch.groups.forEach((g, gi) => {
    const c = g.candidate;
    const base = { index: ctx.firstIndex + gi, batch: ctx.batch, key: c.key, category: c.category, listings: listingRows(c.members) };
    const a = answers.get(g.id)!;
    if (!a.ok) {
      out.rejected++;
      out.rows.push({ ...base, status: 'rejected', reason: a.reason, clusters: null, apart: [], vetoed: [], final: [] });
      return;
    }
    const reps = c.reps ?? c.members.map((_, i) => i);
    const own = reps.map((r, i) => [r, ...(c.attached?.[i] ?? [])]);
    const vl = c.members.map(vetoListing);
    const vetoed: { a: number; b: number; reasons: string[] }[] = [];
    const clusters: number[][] = [];
    let merged = false;
    for (const shown of a.verdict.clusters) {
      const homes: { reps: number[]; members: number[] }[] = [];
      for (const s of shown) {
        const home = homes.find((h) => {
          for (const x of h.members) {
            for (const y of own[s]) {
              const reasons = vetoReasons(vl[x], vl[y]);
              if (reasons.length > 0) {
                vetoed.push({ a: Math.min(x, y), b: Math.max(x, y), reasons });
                return false;
              }
            }
          }
          return true;
        });
        if (home) {
          home.reps.push(s);
          home.members.push(...own[s]);
        } else homes.push({ reps: [s], members: [...own[s]] });
      }
      for (const h of homes) {
        if (h.reps.length > 1) merged = true;
        clusters.push([...h.members].sort((x, y) => x - y));
      }
    }
    clusters.sort((x, y) => x[0] - y[0]);
    const final = applyVeto(vl, clusters).clusters;
    const apart = a.verdict.apart.map((d) => ({ ...d, a: reps[d.a], b: reps[d.b] }));
    out.judged++;
    out.vetoes += vetoed.length;
    if (merged) out.matched++;
    out.rows.push({ ...base, status: 'ok', reason: null, clusters, apart, vetoed, final });
    out.judgements.push({
      key: c.key, fingerprint: c.fingerprint, model: ctx.model, effort: ctx.effort, members: storedMembers(c.members),
      verdict: { clusters, apart, vetoed, final, merge: { sources: c.merge?.sources ?? [] } },
    });
  });
  return out;
}

const refsOf = (j: { members: { shop_id: number; group_key: string }[] }) => j.members.map((m) => memberRef({ shopId: m.shop_id, groupKey: m.group_key }));

/**
 * Stored judgements after saving rows, as saveJudgements does it (src/match/store.ts): a row replaces the judgement
 * of its key; a normal row removes every older judgement sharing a listing with it, a merge row only older merge
 * judgements (the chunk judgements keep their other listings). For a dry run and for the merge pass after judging.
 */
export function overlayJudgements(stored: StoredJudgement[], rows: JudgementRow[], at: Date, merge: boolean): StoredJudgement[] {
  if (rows.length === 0) return stored;
  const keys = new Set(rows.map((r) => r.key));
  const refs = new Set(rows.flatMap(refsOf));
  const kept = stored.filter((j) => !keys.has(j.key) && !((!merge || isMergeKey(j.key)) && refsOf(j).some((r) => refs.has(r))));
  let id = stored.reduce((n, j) => Math.max(n, j.id), 0);
  return [...kept, ...rows.map((r) => ({ ...r, id: ++id, judgedAt: at }))];
}
