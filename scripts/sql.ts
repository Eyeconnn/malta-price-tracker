// Ad-hoc query helper: pnpm sql "select count(*) from products"
import { db, closeDb } from '../src/db.js';

const q = process.argv.slice(2).join(' ');
try {
  console.table(await db().unsafe(q));
} finally {
  await closeDb();
}
