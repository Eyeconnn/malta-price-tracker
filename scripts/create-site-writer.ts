// Creates (or re-passwords) the limited write role `site_writer` used by the public site Worker.
// It may select from every table and insert/update only reports and site_settings.
// Writes the role's URL to .env as SITE_WRITER_DATABASE_URL (skipped for a local dev database).
//   pnpm exec tsx scripts/create-site-writer.ts
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { db, closeDb } from '../src/db.js';
import { env } from '../src/env.js';

const ROLE = 'site_writer';
const ENV_KEY = 'SITE_WRITER_DATABASE_URL';

async function main() {
  const sql = db();
  const password = randomBytes(18).toString('base64url'); // url-safe, no quoting needed
  const exists = (await sql`select 1 from pg_roles where rolname = ${ROLE}`).length > 0;
  await sql.unsafe(`${exists ? 'alter' : 'create'} role ${ROLE} with login password '${password}'`);

  const [{ dbname }] = await sql<{ dbname: string }[]>`select current_database() as dbname`;
  await sql.unsafe(`grant connect on database "${dbname}" to ${ROLE}`);
  await sql.unsafe(`grant usage on schema public to ${ROLE}`);
  await sql.unsafe(`grant select on all tables in schema public to ${ROLE}`);
  await sql.unsafe(`grant select on all sequences in schema public to ${ROLE}`);
  await sql.unsafe(`grant insert, update on reports, site_settings to ${ROLE}`);
  await sql.unsafe(`grant usage on sequence reports_id_seq to ${ROLE}`);
  // tables added by later migrations are readable too
  await sql.unsafe(`alter default privileges in schema public grant select on tables to ${ROLE}`);

  const url = new URL(env('DATABASE_URL'));
  url.username = ROLE;
  url.password = password;

  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    console.log(`${ROLE} ${exists ? 'updated' : 'created'} on the local dev database; .env left alone`);
    return;
  }

  let text = '';
  try {
    text = await readFile('.env', 'utf8');
  } catch {
    // no .env yet
  }
  const line = `${ENV_KEY}=${url.toString()}`;
  const re = new RegExp(`^${ENV_KEY}=.*$`, 'm');
  if (re.test(text)) text = text.replace(re, () => line);
  else text = text + (text && !text.endsWith('\n') ? '\n' : '') + `\n# Limited write role for the public site Worker (reports and site_settings only)\n${line}\n`;
  await writeFile('.env', text);
  console.log(`${ROLE} ${exists ? 'updated' : 'created'}; ${ENV_KEY} written to .env`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
