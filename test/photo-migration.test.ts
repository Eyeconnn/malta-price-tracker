// Migration 014 on PGlite: site_products.image_key, and only the R2 permission failures are cleared for a retry.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let pg: PGlite;
const dir = path.resolve('db/migrations');

beforeAll(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  pg = await PGlite.create({ dataDir: 'memory://', extensions: { pg_trgm } });
  const files = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  for (const f of files.filter((n) => n < '014')) await pg.exec(await readFile(path.join(dir, f), 'utf8'));
  await pg.exec(`
    insert into shops (id, slug, name, base_url, adapter) values (1, 'alpha', 'Alpha', 'https://alpha.example', 'woo');
    insert into images (id, source_url, r2_key, sha256, error) values
      (1, 'https://alpha.example/1.jpg', null, null, 'Access Denied'),
      (2, 'https://alpha.example/2.jpg', null, null, 'R2 upload failed: AccessDenied'),
      (3, 'https://alpha.example/3.jpg', null, null, 'AccessDenied: Access Denied'),
      (4, 'https://alpha.example/4.jpg', null, null, 'HTTP 404'),
      (5, 'https://alpha.example/5.jpg', null, null, 'HTTP 403'),
      (6, 'https://evil.example/6.jpg', null, null, 'image host evil.example not in the allowlist'),
      (7, 'https://alpha.example/7.jpg', 'img/${'a'.repeat(64)}.webp', '${'b'.repeat(64)}', null);
    insert into products (id, shop_id, external_id, title, image_url, image_id) values
      (10, 1, 'P1', 'One', 'https://alpha.example/1.jpg', 1),
      (11, 1, 'P4', 'Four', 'https://alpha.example/4.jpg', 4),
      (12, 1, 'P7', 'Seven', 'https://alpha.example/7.jpg', 7);
  `);
  await pg.exec(await readFile(path.join(dir, files.find((n) => n.startsWith('014'))!), 'utf8'));
});

afterAll(async () => {
  await pg.close();
});

describe('migration 014', () => {
  it('adds site_products.image_key', async () => {
    const cols = await pg.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'site_products' and column_name = 'image_key'`);
    expect(cols.rows).toHaveLength(1);
  });

  it('clears only the failures caused by R2 permissions, and unlinks their products', async () => {
    const ids = (await pg.query<{ id: number }>('select id from images order by id')).rows.map((r) => Number(r.id));
    expect(ids).toEqual([4, 5, 6, 7]);
    const links = (await pg.query<{ id: number; image_id: number | null }>('select id, image_id from products order by id')).rows;
    expect(links.map((r) => [Number(r.id), r.image_id === null ? null : Number(r.image_id)])).toEqual([[10, null], [11, 4], [12, 7]]);
  });

  it('can run again', async () => {
    await pg.exec(await readFile(path.join(dir, (await readdir(dir)).find((n) => n.startsWith('014'))!), 'utf8'));
    expect((await pg.query('select id from images')).rows).toHaveLength(4);
  });
});
