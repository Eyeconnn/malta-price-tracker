// Creates (or re-passwords) the two least-privilege roles used by the public site Worker, and retires the old site_writer.
//   site_reporter  insert on reports; select (ip_hash, created_at) on reports for rate limiting. Nothing else.
//   site_admin     admin panel: read the site tables, edit settings, resolve reports, hide shops, confirm matches,
//                  add shop requests and change their status (retry, reject).
// Writes REPORTER_DATABASE_URL and ADMIN_DATABASE_URL to .env (skipped for a local dev database).
//   pnpm exec tsx scripts/create-site-roles.ts
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { db, closeDb } from '../src/db.js';
import { env } from '../src/env.js';

const ROLES = [
  {
    name: 'site_reporter',
    envKey: 'REPORTER_DATABASE_URL',
    grants: [
      'insert on reports',
      'select (ip_hash, created_at) on reports',
      'usage on sequence reports_id_seq',
    ],
  },
  {
    name: 'site_admin',
    envKey: 'ADMIN_DATABASE_URL',
    grants: [
      'select on site_settings, site_products, shop_ratings, shops, reports, products, price_observations, canonical_products',
      'insert, update on site_settings',
      'update (status, admin_note, resolved_at) on reports',
      'update (site_hidden) on shops',
      'update (match_confirmed) on site_products',
      // Add shop page (migration 009): list, add an address, retry or reject (status only)
      'select on shop_requests',
      'insert (origin, display_name, shop_category) on shop_requests',
      'update (status) on shop_requests',
      'usage on sequence shop_requests_id_seq',
    ],
  },
] as const;

async function main() {
  const sql = db();
  const [{ dbname }] = await sql<{ dbname: string }[]>`select current_database() as dbname`;
  const url = new URL(env('DATABASE_URL'));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

  // retire the first, too-broad role (nothing owns anything under it)
  if ((await sql`select 1 from pg_roles where rolname = 'site_writer'`).length > 0) {
    await sql.unsafe('alter default privileges in schema public revoke select on tables from site_writer');
    // no DROP OWNED: on Neon the owner role is not a member of site_writer, so revoke explicitly (site_writer owns nothing)
    await sql.unsafe('revoke all on all tables in schema public from site_writer');
    await sql.unsafe('revoke all on all sequences in schema public from site_writer');
    await sql.unsafe('revoke all on schema public from site_writer');
    await sql.unsafe(`revoke all on database "${dbname}" from site_writer`);
    await sql.unsafe('drop role site_writer');
    console.log('site_writer dropped');
  }

  const lines: Record<string, string> = {};
  for (const role of ROLES) {
    const password = randomBytes(18).toString('base64url'); // url-safe, no quoting needed
    const exists = (await sql`select 1 from pg_roles where rolname = ${role.name}`).length > 0;
    await sql.unsafe(`${exists ? 'alter' : 'create'} role ${role.name} with login password '${password}'`);
    // start from nothing so a re-run never leaves older grants behind
    await sql.unsafe(`revoke all on all tables in schema public from ${role.name}`);
    await sql.unsafe(`revoke all on all sequences in schema public from ${role.name}`);
    await sql.unsafe(`grant connect on database "${dbname}" to ${role.name}`);
    await sql.unsafe(`grant usage on schema public to ${role.name}`);
    for (const g of role.grants) await sql.unsafe(`grant ${g} to ${role.name}`);
    const u = new URL(url);
    u.username = role.name;
    u.password = password;
    lines[role.envKey] = u.toString();
    console.log(`${role.name} ${exists ? 'updated' : 'created'}`);
  }

  if (local) {
    console.log('local dev database; .env left alone');
    return;
  }

  let text = '';
  try {
    text = await readFile('.env', 'utf8');
  } catch {
    // no .env yet
  }
  text = text.replace(/^SITE_WRITER_DATABASE_URL=.*\r?\n?/m, '').replace(/^# Limited write role for the public site Worker.*\r?\n?/m, '');
  for (const [key, value] of Object.entries(lines)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    const line = `${key}=${value}`;
    if (re.test(text)) text = text.replace(re, () => line);
    else text = text + (text && !text.endsWith('\n') ? '\n' : '') + `\n# Least-privilege role for the public site Worker (${key === 'ADMIN_DATABASE_URL' ? 'admin panel' : 'reports'})\n${line}\n`;
  }
  await writeFile('.env', text);
  console.log('REPORTER_DATABASE_URL and ADMIN_DATABASE_URL written to .env; SITE_WRITER_DATABASE_URL removed');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
