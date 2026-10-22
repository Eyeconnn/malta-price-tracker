// Writes of the name normaliser: only name_runs and product_names, with the owner connection (never in --dry-run).
import type postgres from 'postgres';
import { titleHash, type GroupInput } from './select.js';

export type StoredResult = {
  group: GroupInput;
  category: string;
  status: 'ok' | 'rejected';
  displayName: string | null;
  variantLabel: string | null;
  attrs: Record<string, unknown>;
  reason: string | null;
};

export type RunTotals = {
  batches: number;
  items: number;
  accepted: number;
  rejected: number;
  failedBatches: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  reportPath: string | null;
};

export async function startRun(sql: postgres.Sql, r: { model: string; categories: string[]; pilot: boolean }): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    insert into name_runs (model, categories, pilot, dry_run)
    values (${r.model}, ${r.categories}::text[], ${r.pilot}, false)
    returning id`;
  return Number(row.id);
}

export async function finishRun(sql: postgres.Sql, runId: number, t: RunTotals): Promise<void> {
  await sql`
    update name_runs set finished_at = now(), batches = ${t.batches}, items = ${t.items}, accepted = ${t.accepted},
      rejected = ${t.rejected}, failed_batches = ${t.failedBatches}, input_tokens = ${t.inputTokens},
      output_tokens = ${t.outputTokens}, cache_read_tokens = ${t.cacheReadTokens}, cache_write_tokens = ${t.cacheWriteTokens},
      reported_cost_usd = ${t.costUsd}, report_path = ${t.reportPath}
    where id = ${runId}`;
}

/** Upserts one batch of results into product_names. */
export async function saveResults(sql: postgres.Sql, runId: number, model: string, results: StoredResult[]): Promise<void> {
  if (results.length === 0) return;
  const col = <T>(f: (r: StoredResult) => T) => results.map(f);
  await sql`
    insert into product_names (shop_id, group_key, source_title, title_hash, category, display_name, variant_label, attrs,
      status, reject_reason, model, run_id, normalised_at)
    select t.shop_id, t.group_key, t.source_title, t.title_hash, t.category, t.display_name, t.variant_label, t.attrs::jsonb,
      t.status, t.reject_reason, ${model}, ${runId}, now()
    from unnest(
      ${col((r) => r.group.shopId)}::int[], ${col((r) => r.group.groupKey)}::text[], ${col((r) => r.group.title)}::text[],
      ${col((r) => titleHash(r.group.title, r.group.variantTitles))}::text[], ${col((r) => r.category)}::text[],
      ${col((r) => r.displayName)}::text[], ${col((r) => r.variantLabel)}::text[], ${col((r) => JSON.stringify(r.attrs))}::text[],
      ${col((r) => r.status)}::text[], ${col((r) => r.reason)}::text[]
    ) as t(shop_id, group_key, source_title, title_hash, category, display_name, variant_label, attrs, status, reject_reason)
    on conflict (shop_id, group_key) do update set
      source_title = excluded.source_title, title_hash = excluded.title_hash, category = excluded.category,
      display_name = excluded.display_name, variant_label = excluded.variant_label, attrs = excluded.attrs,
      status = excluded.status, reject_reason = excluded.reject_reason, model = excluded.model, run_id = excluded.run_id,
      normalised_at = excluded.normalised_at`;
}
