// Applies db/migrations/*.sql in name order, each once, each in a transaction.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { db, closeDb } from '../db.js';

const dir = path.resolve('db/migrations');

async function main() {
  const sql = db();
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const text = await readFile(path.join(dir, f), 'utf8');
    console.log(`applying ${f}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${f})`;
    });
  }
  console.log('migrations up to date');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
