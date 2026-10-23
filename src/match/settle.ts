// One judged batch turned into what the judge reports and stores: each group's answer read (judge.ts), the veto
// applied to the clusters Claude called the same (veto.ts), and a judgement row per valid answer.
import type { Listing } from './candidates.js';
import { normText } from './fingerprint.js';
import { readAnswers, type JudgeBatch } from './judge.js';
import type { JudgeGroupRow } from './report.js';
import type { JudgementRow } from './store.js';
import { applyVeto, type VetoListing } from './veto.js';

export const vetoListing = (l: Pick<Listing, 'title' | 'variantTitles' | 'brand' | 'category' | 'categoryPath' | 'gtin' | 'mpn' | 'shopId'> & { priceCents?: number | null }): VetoListing => ({
  title: l.title, variantTitles: l.variantTitles, brand: l.brand, category: l.category, categoryPath: l.categoryPath, gtin: l.gtin, mpn: l.mpn,
  shopId: l.shopId, priceCents: l.priceCents,
});

const listingRows = (members: Listing[]) => members.map((m) => ({ shop: m.shopSlug, shopId: m.shopId, groupKey: m.groupKey, title: m.title, priceCents: m.priceCents }));

export type Settled = { rows: JudgeGroupRow[]; judgements: JudgementRow[]; judged: number; rejected: number; matched: number; vetoes: number };

/** ctx.firstIndex: the report number of the batch's first group. */
export function settleBatch(batch: JudgeBatch, output: unknown, ctx: { model: string; effort: string | null; batch: number; firstIndex: number }): Settled {
  const answers = readAnswers(batch, output);
  const out: Settled = { rows: [], judgements: [], judged: 0, rejected: 0, matched: 0, vetoes: 0 };
  batch.groups.forEach((g, i) => {
    const c = g.candidate;
    const base = { index: ctx.firstIndex + i, batch: ctx.batch, key: c.key, category: c.category, listings: listingRows(c.members) };
    const a = answers.get(g.id)!;
    if (!a.ok) {
      out.rejected++;
      out.rows.push({ ...base, status: 'rejected', reason: a.reason, clusters: null, apart: [], vetoed: [], final: [] });
      return;
    }
    const veto = applyVeto(c.members.map(vetoListing), a.verdict.clusters);
    out.judged++;
    out.vetoes += veto.vetoed.length;
    if (veto.clusters.length > 0) out.matched++;
    out.rows.push({ ...base, status: 'ok', reason: null, clusters: a.verdict.clusters, apart: a.verdict.apart, vetoed: veto.vetoed, final: veto.clusters });
    out.judgements.push({
      key: c.key,
      fingerprint: c.fingerprint,
      model: ctx.model,
      effort: ctx.effort,
      members: c.members.map((m) => ({
        shop_id: m.shopId, group_key: m.groupKey, site_product_id: m.id, title: normText(m.title),
        variants: [...new Set(m.variantTitles.map(normText).filter((v) => v !== ''))].sort(),
      })),
      verdict: { clusters: a.verdict.clusters, apart: a.verdict.apart, vetoed: veto.vetoed, final: veto.clusters },
    });
  });
  return out;
}

/** The report rows of a batch whose Claude call failed: nothing is stored, so the groups are judged next time. */
export function failedBatch(batch: JudgeBatch, error: string, ctx: { batch: number; firstIndex: number }): JudgeGroupRow[] {
  return batch.groups.map((g, i) => ({
    index: ctx.firstIndex + i, batch: ctx.batch, key: g.candidate.key, category: g.candidate.category, listings: listingRows(g.candidate.members),
    status: 'failed', reason: error, clusters: null, apart: [], vetoed: [], final: [],
  }));
}
