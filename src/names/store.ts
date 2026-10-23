// Writes of the name normaliser: only name_runs and product_names, with the owner connection (never in --dry-run).
import type postgres from 'postgres';
import type { StoredName } from './recheck.js';
import { titleHash, type GroupInput } from './select.js';

export type StoredResult = {
  group: GroupInput;
  category: string;
  status: 'ok' | 'rejected';
  displayName: string | null;
  variantLabel: string | null;
  attrs: Record<string, unknown>;
  reason: string | null;
  /** the checked canonical name (src/names/canonical.ts), null without one */
  canonicalName?: string | null;
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

export async function startRun(
  sql: postgres.Sql,
  r: { model: string; categories: string[]; pilot: boolean; effort?: string | null },
): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    insert into name_runs (model, effort, categories, pilot, dry_run)
    values (${r.model}, ${r.effort ?? null}, ${r.categories}::text[], ${r.pilot}, false)
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

/** Whether product_names has canonical_name yet (migration 012), asked once per connection. */
const hasCanonical = new WeakMap<postgres.Sql, Promise<boolean>>();
function canonicalColumn(sql: postgres.Sql): Promise<boolean> {
  let p = hasCanonical.get(sql);
  if (!p) {
    p = sql`select 1 from information_schema.columns where table_name = 'product_names' and column_name = 'canonical_name'`.then((r) => r.length > 0);
    hasCanonical.set(sql, p);
  }
  return p;
}

/** Upserts one batch of results into product_names (with canonical_name once migration 012 has run). */
export async function saveResults(sql: postgres.Sql, runId: number, model: string, results: StoredResult[]): Promise<void> {
  if (results.length === 0) return;
  const withCanonical = await canonicalColumn(sql);
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
  if (!withCanonical) return;
  await sql`
    update product_names pn set canonical_name = t.canonical_name
    from unnest(${col((r) => r.group.shopId)}::int[], ${col((r) => r.group.groupKey)}::text[], ${col((r) => (r.status === 'ok' ? (r.canonicalName ?? null) : null))}::text[])
      as t(shop_id, group_key, canonical_name)
    where pn.shop_id = t.shop_id and pn.group_key = t.group_key`;
}

/** The names stored as ok (for --recheck-stored). */
export async function loadStoredOk(sql: postgres.Sql): Promise<StoredName[]> {
  const rows = await sql<{ shop_id: number; group_key: string; category: string | null; display_name: string; variant_label: string | null; attrs: Record<string, unknown> }[]>`
    select shop_id, group_key, category, display_name, variant_label, attrs
    from product_names where status = 'ok' and display_name is not null`;
  return rows.map((r) => ({ shopId: r.shop_id, groupKey: r.group_key, category: r.category, displayName: r.display_name, variantLabel: r.variant_label, attrs: r.attrs ?? {} }));
}

/** Marks stored names rejected that the current checks fail (--recheck-stored); the site then keeps the shop title. */
export async function markRejected(sql: postgres.Sql, rows: { shopId: number; groupKey: string; reason: string }[]): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await sql`
    update product_names pn set status = 'rejected', reject_reason = 'recheck: ' || t.reason, display_name = null,
      variant_label = null, attrs = '{}'::jsonb, normalised_at = now()
      ${(await canonicalColumn(sql)) ? sql`, canonical_name = null` : sql``}
    from unnest(${rows.map((r) => r.shopId)}::int[], ${rows.map((r) => r.groupKey)}::text[], ${rows.map((r) => r.reason)}::text[])
      as t(shop_id, group_key, reason)
    where pn.shop_id = t.shop_id and pn.group_key = t.group_key and pn.status = 'ok'`;
  return res.count;
}
