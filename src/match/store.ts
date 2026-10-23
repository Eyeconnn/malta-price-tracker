// Reads and writes of match_judgements and judge_runs (migration 013). The judge writes only with the owner
// connection and never in --dry-run; reads work before the migration (no tables: nothing stored).
import type postgres from 'postgres';
import { memberRef } from './fingerprint.js';

export type StoredMember = { shop_id: number; group_key: string; site_product_id: number };
export type StoredVerdict = {
  /** Claude's clusters (indexes into members), every member in one */
  clusters: number[][];
  /** the differences Claude listed between clusters */
  apart: { a: number; b: number; differences: string[] }[];
  /** pairs Claude put together that the veto overruled */
  vetoed: { a: number; b: number; reasons: string[] }[];
  /** the clusters of two or more after the veto */
  final: number[][];
};
export type JudgementRow = { key: string; members: StoredMember[]; fingerprint: string; verdict: StoredVerdict; model: string; effort: string | null };
export type StoredJudgement = JudgementRow & { id: number; judgedAt: Date };

/** Whether migration 013 has run (both tables exist). */
export async function hasJudgeTables(sql: postgres.Sql): Promise<boolean> {
  const [r] = await sql<{ j: string | null; r: string | null }[]>`select to_regclass('match_judgements')::text as j, to_regclass('judge_runs')::text as r`;
  return r.j !== null && r.r !== null;
}

/** The stored fingerprint of every candidate key (empty before migration 013). */
export async function loadStoredFingerprints(sql: postgres.Sql): Promise<Map<string, string>> {
  if (!(await hasJudgeTables(sql))) return new Map();
  const rows = await sql<{ candidate_key: string; fingerprint: string }[]>`select candidate_key, fingerprint from match_judgements`;
  return new Map(rows.map((r) => [r.candidate_key, r.fingerprint]));
}

/** Every stored judgement, newest first (empty before migration 013). */
export async function loadJudgements(sql: postgres.Sql): Promise<StoredJudgement[]> {
  if (!(await hasJudgeTables(sql))) return [];
  const rows = await sql<{ id: string; candidate_key: string; members: StoredMember[]; fingerprint: string; verdict: StoredVerdict; model: string; effort: string | null; judged_at: Date }[]>`
    select id, candidate_key, members, fingerprint, verdict, model, effort, judged_at from match_judgements order by judged_at desc, id desc`;
  return rows.map((r) => ({
    id: Number(r.id), key: r.candidate_key, members: r.members, fingerprint: r.fingerprint, verdict: r.verdict, model: r.model, effort: r.effort, judgedAt: r.judged_at,
  }));
}

export async function startJudgeRun(sql: postgres.Sql, r: { model: string; effort: string | null; pilot: boolean }): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    insert into judge_runs (model, effort, pilot, dry_run) values (${r.model}, ${r.effort}, ${r.pilot}, false) returning id`;
  return Number(row.id);
}

export type JudgeTotals = {
  batches: number;
  groups: number;
  judged: number;
  rejected: number;
  matched: number;
  vetoes: number;
  failedBatches: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  costUsd: number;
  reportPath: string | null;
};

export async function finishJudgeRun(sql: postgres.Sql, runId: number, t: JudgeTotals): Promise<void> {
  await sql`
    update judge_runs set finished_at = now(), batches = ${t.batches}, groups = ${t.groups}, judged = ${t.judged}, rejected = ${t.rejected},
      matched = ${t.matched}, vetoes = ${t.vetoes}, failed_batches = ${t.failedBatches}, input_tokens = ${t.inputTokens},
      output_tokens = ${t.outputTokens}, cache_read_tokens = ${t.cacheReadTokens}, cache_write_tokens = ${t.cacheWriteTokens},
      thinking_tokens = ${t.thinkingTokens}, reported_cost_usd = ${t.costUsd}, report_path = ${t.reportPath}
    where id = ${runId}`;
}

/**
 * Upserts judgements by candidate key, and deletes older judgements of other candidate keys that share a listing
 * with them (the group the listing belongs to changed), in one transaction. Returns how many were saved and removed.
 */
export async function saveJudgements(sql: postgres.Sql, runId: number, rows: JudgementRow[]): Promise<{ saved: number; superseded: number }> {
  if (rows.length === 0) return { saved: 0, superseded: 0 };
  const keys = rows.map((r) => r.key);
  const refs = [...new Set(rows.flatMap((r) => r.members.map((m) => memberRef({ shopId: m.shop_id, groupKey: m.group_key }))))];
  let superseded = 0;
  await sql.begin(async (tx) => {
    await tx`
      insert into match_judgements (candidate_key, members, fingerprint, verdict, model, effort, judged_at, run_id)
      select t.key, t.members::jsonb, t.fingerprint, t.verdict::jsonb, t.model, t.effort, now(), ${runId}
      from unnest(${keys}::text[], ${rows.map((r) => JSON.stringify(r.members))}::text[], ${rows.map((r) => r.fingerprint)}::text[],
        ${rows.map((r) => JSON.stringify(r.verdict))}::text[], ${rows.map((r) => r.model)}::text[], ${rows.map((r) => r.effort)}::text[])
        as t(key, members, fingerprint, verdict, model, effort)
      on conflict (candidate_key) do update set members = excluded.members, fingerprint = excluded.fingerprint, verdict = excluded.verdict,
        model = excluded.model, effort = excluded.effort, judged_at = excluded.judged_at, run_id = excluded.run_id`;
    const res = await tx`
      delete from match_judgements j
      where not (j.candidate_key = any(${keys}::text[]))
        and exists (
          select 1 from jsonb_array_elements(j.members) m
          where (m ->> 'shop_id') || '|' || (m ->> 'group_key') = any(${refs}::text[]))`;
    superseded = res.count;
  });
  return { saved: rows.length, superseded };
}
