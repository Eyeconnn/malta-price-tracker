// One-off: Black Friday status for products stored before migration 002, from their saved tags and
// categories. Marker dates are set to first_seen and bf_preexisting = true (real start unknown).
import { db, closeDb } from '../src/db.js';
import { detectBlackFriday } from '../src/util/blackfriday.js';
import { blankRecord } from '../src/util/normalise.js';

const sql = db();
let lastId = 0;
let updated = 0;
for (;;) {
  const rows = await sql<{ id: string; tags: string[] | null; category_path: string | null; first_seen: Date }[]>`
    select id, tags, category_path, first_seen from products
    where id > ${lastId} and bf_status is null order by id limit 5000`;
  if (!rows.length) break;
  lastId = Number(rows[rows.length - 1]!.id);
  const hits = rows
    .map((r) => ({ id: Number(r.id), first_seen: r.first_seen, bf: detectBlackFriday({ ...blankRecord(''), tags: r.tags ?? [], category_path: r.category_path }) }))
    .filter((r) => r.bf)
    .map((r) => ({ id: r.id, status: r.bf!.status, marker: r.bf!.marker, first_seen: r.first_seen }));
  if (hits.length) {
    await sql`
      update products p set bf_status = x.status, bf_marker = x.marker,
        bf_first_marked_at = case when x.status = 'marked' then x.first_seen end,
        bf_last_marked_at = case when x.status = 'marked' then x.first_seen end,
        bf_preexisting = (x.status = 'marked')
      from jsonb_to_recordset(${sql.json(hits as never)}) as x(id bigint, status text, marker text, first_seen timestamptz)
      where p.id = x.id`;
    updated += hits.length;
  }
}
console.log(`backfilled ${updated} products`);
await closeDb();
