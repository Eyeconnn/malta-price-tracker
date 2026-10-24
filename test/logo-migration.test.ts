// Migration 016 on PGlite: shops.logo_key, logo_checked_at and logo_error, and it can run again.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let pg: PGlite;
const dir = path.resolve('db/migrations');
const file = async () => (await readdir(dir)).find((n) => n.startsWith('016'))!;

beforeAll(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  pg = await PGlite.create({ dataDir: 'memory://', extensions: { pg_trgm } });
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(await readFile(path.join(dir, f), 'utf8'));
});

afterAll(async () => {
  await pg.close();
});

describe('migration 016', () => {
  it('adds the logo columns to shops', async () => {
    const cols = await pg.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_name = 'shops' and column_name like 'logo%' order by column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: 'logo_checked_at', data_type: 'timestamp with time zone' },
      { column_name: 'logo_error', data_type: 'text' },
      { column_name: 'logo_key', data_type: 'text' },
    ]);
  });

  it('can run again and keeps the values', async () => {
    await pg.exec(`insert into shops (slug, name, base_url, adapter, logo_key) values ('a', 'A', 'https://a.example', 'woo', 'img/${'a'.repeat(64)}.webp')`);
    await pg.exec(await readFile(path.join(dir, await file()), 'utf8'));
    expect((await pg.query<{ logo_key: string }>(`select logo_key from shops where slug = 'a'`)).rows[0]!.logo_key).toBe(`img/${'a'.repeat(64)}.webp`);
  });
});
