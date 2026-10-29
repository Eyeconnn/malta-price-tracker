// Upserts shops.seed.json into the shops table (on slug). Does not delete shops missing from the file.
import { db, closeDb } from '../db.js';
import { readSeed } from '../shops.js';

async function main() {
  const seed = await readSeed();
  const sql = db();
  for (const s of seed.shops) {
    await sql`
      insert into shops (slug, name, base_url, category, adapter, config, tier, active, notes, unavailable_reason)
      values (${s.slug}, ${s.name}, ${s.base_url}, ${s.category}, ${s.adapter}, ${sql.json((s.config ?? {}) as never)},
              ${s.tier}, ${s.active}, ${s.notes ?? null}, ${s.unavailable_reason ?? null})
      on conflict (slug) do update set
        name = excluded.name, base_url = excluded.base_url, category = excluded.category,
        adapter = excluded.adapter, config = excluded.config, tier = excluded.tier,
        active = excluded.active, notes = excluded.notes, unavailable_reason = excluded.unavailable_reason, updated_at = now()`;
  }
  console.log(`seeded ${seed.shops.length} shops`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
