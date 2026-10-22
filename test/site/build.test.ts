import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { DEFAULT_SETTINGS, loadSettings } from '../../src/site/settings.js';
import type { Obs, Verdict } from '../../src/site/verdict.js';
import {
  buildShopRatings,
  buildSiteProducts,
  lastFullBuild,
  markFullBuild,
  pctColumn,
  withBuildLock,
  pickRepresentative,
  pickVerdictVariant,
  toObs,
  type VariantResult,
} from '../../src/site/build.js';

// ---------- pure helpers (always run) ----------

function verdict(label: Verdict['label'], extra: Partial<Verdict['facts']> = {}): Verdict {
  return {
    label,
    reason: label,
    facts: { low30: null, usual: null, claimedPct: null, realPct: null, historyDays: 20, priceChanges: 0, wasChanges: 0, daysWorthBuying: 0, ...extra },
  };
}

function variant(id: string, price: number | null, inStock: boolean | null, v: Verdict, was: number | null = null): VariantResult {
  const latest: Obs | null = price === null && inStock === null ? null : { at: new Date('2026-10-22T12:00:00Z'), price, was, inStock, bf: false };
  return { product: { id, bf_status: null } as VariantResult['product'], latest, verdict: v };
}

describe('toObs', () => {
  const row = { product_id: '1', observed_at: new Date('2026-10-22T12:00:00Z'), price_cents: 100, was_price_cents: null, in_stock: true };

  it('uses bf_marked when the observation has it', () => {
    expect(toObs({ ...row, bf_marked: true }, null).bf).toBe(true);
    expect(toObs({ ...row, bf_marked: false }, 'marked').bf).toBe(false);
  });

  it("falls back to the product's bf_status for older rows without bf_marked", () => {
    expect(toObs({ ...row, bf_marked: null }, 'marked').bf).toBe(true);
    expect(toObs({ ...row, bf_marked: null }, 'excluded').bf).toBe(false);
    expect(toObs({ ...row, bf_marked: null }, 'stale').bf).toBe(false);
    expect(toObs({ ...row, bf_marked: null }, null).bf).toBe(false);
  });

  it('maps prices and stock', () => {
    expect(toObs({ ...row, was_price_cents: 200, bf_marked: null }, null)).toEqual({
      at: row.observed_at,
      price: 100,
      was: 200,
      inStock: true,
      bf: false,
    });
  });
});

describe('pctColumn', () => {
  it('rounds to 2 decimals and nulls what numeric(5,2) cannot hold', () => {
    expect(pctColumn(12.7)).toBe(12.7);
    expect(pctColumn(-10.126)).toBe(-10.13);
    expect(pctColumn(999.994)).toBe(999.99);
    expect(pctColumn(999.996)).toBeNull();
    expect(pctColumn(999.995)).toBeNull();
    expect(pctColumn(-999.996)).toBeNull();
    expect(pctColumn(1000)).toBeNull();
    expect(pctColumn(-0.001)).toBe(0);
    expect(pctColumn(null)).toBeNull();
    expect(pctColumn(Number.NaN)).toBeNull();
  });
});

describe('pickRepresentative', () => {
  it('takes the cheapest in-stock variant with a positive price', () => {
    const vs = [variant('1', 500, true, verdict('none')), variant('2', 300, false, verdict('none')), variant('3', 400, true, verdict('none')), variant('4', 0, true, verdict('none'))];
    expect(pickRepresentative(vs).product.id).toBe('3');
  });

  it('falls back to the cheapest variant when none is in stock', () => {
    const vs = [variant('1', 500, false, verdict('none')), variant('2', 300, null, verdict('none'))];
    expect(pickRepresentative(vs).product.id).toBe('2');
  });

  it('falls back to the first variant when no price is shown', () => {
    const vs = [variant('7', null, null, verdict('insufficient')), variant('8', null, false, verdict('insufficient'))];
    expect(pickRepresentative(vs).product.id).toBe('7');
  });
});

describe('pickVerdictVariant', () => {
  it('takes the worst label among in-stock variants', () => {
    const vs = [variant('1', 500, true, verdict('good')), variant('2', 300, true, verdict('none')), variant('3', 200, false, verdict('avoid'))];
    expect(pickVerdictVariant(vs, vs[1]).product.id).toBe('1');
  });

  it('ranks avoid over good over none over insufficient', () => {
    const vs = [variant('1', 500, true, verdict('insufficient')), variant('2', 300, true, verdict('none')), variant('3', 400, true, verdict('avoid'))];
    expect(pickVerdictVariant(vs, vs[1]).verdict.label).toBe('avoid');
    const ws = [variant('1', 500, true, verdict('insufficient')), variant('2', 300, true, verdict('none'))];
    expect(pickVerdictVariant(ws, ws[1]).verdict.label).toBe('none');
  });

  it('uses all variants when none is in stock', () => {
    const vs = [variant('1', 500, false, verdict('none')), variant('2', 300, null, verdict('avoid'))];
    expect(pickVerdictVariant(vs, vs[1]).product.id).toBe('2');
  });

  it('prefers the avoid variant with the largest rise', () => {
    const small = verdict('avoid', { raisedFrom: { price: 1000, at: '2026-10-20' }, raisedTo: { price: 1100, at: '2026-10-22' } });
    const big = verdict('avoid', { raisedFrom: { price: 1000, at: '2026-10-20' }, raisedTo: { price: 1500, at: '2026-10-22' } });
    const wasOnly = verdict('avoid', { wasRaisedFrom: 1000 });
    const vs = [variant('1', 1100, true, small), variant('2', 1500, true, big), variant('3', 900, true, wasOnly, 1200)];
    expect(pickVerdictVariant(vs, vs[2]).product.id).toBe('2');
  });

  it('prefers the representative among variants with the same non-avoid label', () => {
    const vs = [variant('1', 500, true, verdict('good')), variant('2', 300, true, verdict('good'))];
    expect(pickVerdictVariant(vs, vs[1]).product.id).toBe('2');
  });
});

// ---------- integration on a throwaway PGlite server (only when SITE_BUILD_TEST_DB is set) ----------

const PORT = 55459;
const NOW = new Date('2026-10-22T20:00:00Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!process.env.SITE_BUILD_TEST_DB)('site-build on PGlite', () => {
  let stop: () => Promise<void> = async () => {};
  let sql: postgres.Sql;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
    const pg = await PGlite.create({ dataDir: 'memory://', extensions: { pg_trgm } });
    const server = new PGLiteSocketServer({ db: pg, port: PORT, host: '127.0.0.1', maxConnections: 10 } as never);
    await server.start();
    sql = postgres(`postgres://postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`, { max: 1, onnotice: () => {} });
    stop = async () => {
      await sql.end({ timeout: 5 });
      await server.stop();
      await pg.close();
    };

    const dir = path.resolve('db/migrations');
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await sql.unsafe(await readFile(path.join(dir, f), 'utf8'));
    }

    const shop = async (slug: string, hidden = false) =>
      (await sql<{ id: number }[]>`
        insert into shops (slug, name, base_url, category, adapter, site_hidden)
        values (${slug}, ${slug}, ${'https://' + slug + '.test'}, 'electronics', 'woo', ${hidden}) returning id`)[0].id;
    const a = await shop('lenovoshop');
    const b = await shop('othershop');
    const c = await shop('hiddenshop', true);
    ids.a = String(a);
    ids.b = String(b);
    ids.c = String(c);

    const product = async (shopId: number, p: Record<string, unknown>) =>
      (
        await sql<{ id: string }[]>`
          insert into products ${sql({ shop_id: shopId, last_seen: new Date(NOW.getTime() - HOUR), ...p } as Record<string, postgres.ParameterOrJSON<never>>)}
          returning id`
      )[0].id;
    ids.v16 = await product(a, {
      external_id: 'P1-16',
      parent_external_id: 'P1',
      title: 'Lenovo IdeaPad Slim 5',
      variant_title: '16GB',
      gtin: '5901234123457',
      category_path: 'Computers > Laptops',
      url: 'https://lenovoshop.test/p1?v=16',
      bf_status: 'marked',
    });
    ids.v8 = await product(a, {
      external_id: 'P1-8',
      parent_external_id: 'P1',
      title: 'Lenovo IdeaPad Slim 5',
      variant_title: '8GB',
      gtin: '4006381333931',
      category_path: 'Computers > Laptops',
      url: 'https://lenovoshop.test/p1?v=8',
      image_url: 'https://lenovoshop.test/p1.jpg',
    });
    ids.mid = await product(a, { external_id: 'MID', title: 'Seen 5 days ago', last_seen: new Date(NOW.getTime() - 5 * DAY) });
    ids.old = await product(a, { external_id: 'OLD', title: 'Seen 10 days ago', last_seen: new Date(NOW.getTime() - 10 * DAY) });
    ids.b1 = await product(b, { external_id: 'B1', title: 'Lenovo IdeaPad Slim 5 16GB', gtin: '5901234123457' });
    // a none group with two variants shows its cheapest in-stock variant
    ids.k1 = await product(a, { external_id: 'K1-L', parent_external_id: 'K1', title: 'Kettle', variant_title: 'Large', url: 'https://lenovoshop.test/k1?v=l' });
    ids.k2 = await product(a, { external_id: 'K1-S', parent_external_id: 'K1', title: 'Kettle', variant_title: 'Small', url: 'https://lenovoshop.test/k1?v=s' });
    ids.c1 = await product(c, { external_id: 'C1', title: 'Hidden shop product', gtin: '4006381333931' });

    type O = { product_id: string; observed_at: Date; price_cents: number; was_price_cents: number | null; in_stock: boolean; bf_marked: boolean | null };
    const rows: O[] = [];
    const add = (pid: string, day: string, price: number, was: number | null, bf: boolean | null) =>
      rows.push({ product_id: pid, observed_at: new Date(`${day}T12:00:00Z`), price_cents: price, was_price_cents: was, in_stock: true, bf_marked: bf });
    // Lenovo 16GB: the brief's history; 8GB: unchanged, old rows without bf_marked
    for (let i = 0; i < 15; i++) add(ids.v16, addDays('2026-10-06', i), 70900, 73900, false);
    add(ids.v16, '2026-10-21', 70900, 73900, true);
    add(ids.v16, '2026-10-22', 79900, 88900, true);
    for (let i = 0; i < 17; i++) add(ids.v8, addDays('2026-10-06', i), 64900, null, null);
    for (let i = 0; i < 17; i++) add(ids.k1, addDays('2026-10-06', i), 4500, null, false);
    for (let i = 0; i < 17; i++) add(ids.k2, addDays('2026-10-06', i), 3500, null, false);
    add(ids.b1, '2026-10-22', 69900, null, false);
    add(ids.c1, '2026-10-22', 50000, null, false);
    await sql`insert into price_observations ${sql(rows as never)}`;

    // existing site rows: the Lenovo group with a confirmed match, a stale group, a recent group and a hidden shop's row
    await sql`
      insert into site_products (shop_id, group_key, title, verdict, match_confirmed, updated_at) values
        (${a}, 'P1', 'old title', 'none', true, ${new Date(NOW.getTime() - DAY)}),
        (${a}, 'OLD', 'Seen 10 days ago', 'none', false, ${new Date(NOW.getTime() - 9 * DAY)}),
        (${a}, 'MID', 'Seen 5 days ago', 'none', false, ${new Date(NOW.getTime() - 4 * DAY)}),
        (${c}, 'C1', 'Hidden shop product', 'none', false, ${new Date(NOW.getTime() - DAY)})`;
  }, 120_000);

  afterAll(async () => {
    await stop();
  }, 30_000);

  type Row = {
    id: string;
    shop_id: number;
    group_key: string;
    title: string;
    category: string;
    variant_count: number;
    rep_product_id: string;
    gtin: string | null;
    url: string | null;
    image_url: string | null;
    price_cents: number | null;
    was_price_cents: number | null;
    in_stock: boolean | null;
    bf_status: string | null;
    verdict: string;
    reason: string | null;
    facts: Record<string, unknown> | null;
    canonical_id: string | null;
    match_method: string | null;
    match_confirmed: boolean;
    updated_at: Date;
  };
  const rowsOf = () => sql<Row[]>`select * from site_products order by shop_id, group_key`;
  const find = (rows: Row[], shop: string, key: string) => rows.find((r) => String(r.shop_id) === shop && r.group_key === key);

  it('builds the Lenovo group as avoid and matches it to the other shop by GTIN', async () => {
    const res = await buildSiteProducts(sql, DEFAULT_SETTINGS, NOW);
    expect(res).toEqual({ products: 3, judged: 1 });

    const rows = await rowsOf();
    const lenovo = find(rows, ids.a, 'P1')!;
    expect(lenovo.verdict).toBe('avoid');
    expect(lenovo.variant_count).toBe(2);
    expect(lenovo.reason).toBe('Price went from €709.00 on 21 Oct to €799.00 on 22 Oct while marked Black Friday.');
    expect(lenovo.facts?.wasRaisedFrom).toBe(73900);
    expect(lenovo.title).toBe('Lenovo IdeaPad Slim 5');
    expect(lenovo.category).toBe('laptops');
    // an avoid group shows the variant that produced the label: the 16GB, not the cheaper 8GB
    expect(lenovo.rep_product_id).toBe(ids.v16);
    expect(lenovo.price_cents).toBe(79900);
    expect(lenovo.was_price_cents).toBe(88900);
    expect(lenovo.in_stock).toBe(true);
    expect(lenovo.gtin).toBe('5901234123457');
    expect(lenovo.url).toBe('https://lenovoshop.test/p1?v=16');
    // the 16GB has no picture of its own: the representative's is used
    expect(lenovo.image_url).toBe('https://lenovoshop.test/p1.jpg');
    expect(lenovo.bf_status).toBe('marked');
    expect(lenovo.updated_at.getTime()).toBe(NOW.getTime());
    // Ruling R50: the row joined a canonical group (it had none), so the old confirmation is dropped
    expect(lenovo.match_confirmed).toBe(false);

    const kettle = find(rows, ids.a, 'K1')!;
    expect(kettle.verdict).toBe('none');
    expect(kettle.rep_product_id).toBe(ids.k2);
    expect(kettle.price_cents).toBe(3500);
    expect(kettle.url).toBe('https://lenovoshop.test/k1?v=s');
    expect(kettle.variant_count).toBe(2);

    const other = find(rows, ids.b, 'B1')!;
    expect(other.verdict).toBe('insufficient');
    expect(lenovo.canonical_id).not.toBeNull();
    expect(lenovo.canonical_id).toBe(other.canonical_id);
    expect(lenovo.match_method).toBe('gtin');
    expect(other.match_method).toBe('gtin');

    const canon = await sql`select match_key, title from canonical_products where id = ${lenovo.canonical_id}`;
    expect(canon[0].match_key).toBe('gtin:05901234123457');

    // stale and hidden rows are gone, the group seen 5 days ago stays untouched
    expect(find(rows, ids.a, 'OLD')).toBeUndefined();
    expect(find(rows, ids.c, 'C1')).toBeUndefined();
    expect(find(rows, ids.a, 'MID')?.title).toBe('Seen 5 days ago');
    expect(rows).toHaveLength(4);

    const verdicts = await sql`select product_id, label, price_cents, was_price_cents, low_30d_cents, history_days, claimed_pct, real_pct, computed_at from verdicts`;
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ product_id: ids.v16, label: 'avoid', price_cents: 79900, was_price_cents: 88900, low_30d_cents: 70900, history_days: 17 });
    expect(Number(verdicts[0].real_pct)).toBe(12.7);
    expect(Number(verdicts[0].claimed_pct)).toBe(-10.1);
  }, 60_000);

  it('rates visible shops from the built groups', async () => {
    const n = await buildShopRatings(sql, DEFAULT_SETTINGS, NOW);
    expect(n).toBe(2);
    const ratings = await sql`select shop_id, grade, judged, good, avoid, was_raised, sentence from shop_ratings order by shop_id`;
    expect(ratings).toHaveLength(2);
    expect(ratings[0]).toMatchObject({ shop_id: Number(ids.a), grade: null, judged: 1, good: 0, avoid: 1, was_raised: 1 });
    expect(ratings[0].sentence).toBe('Not rated yet: not enough Black Friday deals checked.');
    expect(ratings[1]).toMatchObject({ shop_id: Number(ids.b), grade: null, judged: 0 });

    const graded = await buildShopRatings(sql, { ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_SETTINGS.thresholds, minJudgedForRating: 1 } }, NOW);
    expect(graded).toBe(2);
    const [a] = await sql`select grade from shop_ratings where shop_id = ${Number(ids.a)}`;
    expect(a.grade).toBe('F');
  }, 60_000);

  it('keeps a match confirmation while the row stays in the same canonical group (R50)', async () => {
    await sql`update site_products set match_confirmed = true where shop_id in (${Number(ids.a)}, ${Number(ids.b)}) and group_key in ('P1', 'B1')`;
    const before = await rowsOf();
    await buildSiteProducts(sql, DEFAULT_SETTINGS, new Date(NOW.getTime() + HOUR / 2));
    const rows = await rowsOf();
    for (const [shop, key] of [[ids.a, 'P1'], [ids.b, 'B1']] as const) {
      expect(find(rows, shop, key)!.canonical_id).toBe(find(before, shop, key)!.canonical_id);
      expect(find(rows, shop, key)!.match_confirmed).toBe(true);
    }
  }, 60_000);

  it('clears a match that no longer holds, and its confirmation with it (R50)', async () => {
    await sql`update products set gtin = '4006381333931' where id = ${ids.b1}`;
    const res = await buildSiteProducts(sql, DEFAULT_SETTINGS, new Date(NOW.getTime() + HOUR));
    expect(res.products).toBe(3);
    const rows = await rowsOf();
    const lenovo = find(rows, ids.a, 'P1')!;
    expect(lenovo.canonical_id).toBeNull();
    expect(lenovo.match_method).toBeNull();
    expect(lenovo.match_confirmed).toBe(false);
    expect(find(rows, ids.b, 'B1')!.canonical_id).toBeNull();
    expect(find(rows, ids.b, 'B1')!.match_confirmed).toBe(false);
    // each run (three so far) adds a verdicts row for the avoid group
    const [{ n }] = await sql`select count(*)::int as n from verdicts`;
    expect(n).toBe(3);
  }, 60_000);

  it('builds only the named shop with { shop }', async () => {
    await sql`update products set title = 'Renamed' where id = ${ids.b1}`;
    const res = await buildSiteProducts(sql, DEFAULT_SETTINGS, new Date(NOW.getTime() + 2 * HOUR), { shop: 'lenovoshop' });
    expect(res.products).toBe(2);
    const rows = await rowsOf();
    expect(find(rows, ids.b, 'B1')!.title).toBe('Lenovo IdeaPad Slim 5 16GB');
  }, 60_000);

  it('runs the build under the advisory lock and frees it afterwards', async () => {
    let calls = 0;
    expect(await withBuildLock(sql, async () => void calls++)).toBe(true);
    expect(await withBuildLock(sql, async () => void calls++)).toBe(true);
    expect(calls).toBe(2);
    const [{ held }] = await sql`select count(*)::int as held from pg_locks where locktype = 'advisory'`;
    expect(held).toBe(0);
    await expect(withBuildLock(sql, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  }, 60_000);

  it('records the last full build in site_settings without changing the loaded settings', async () => {
    expect(await lastFullBuild(sql)).toBeNull();
    await markFullBuild(sql, NOW);
    expect((await lastFullBuild(sql))?.toISOString()).toBe(NOW.toISOString());
    const later = new Date(NOW.getTime() + DAY);
    await markFullBuild(sql, later);
    expect((await lastFullBuild(sql))?.toISOString()).toBe(later.toISOString());
    const [row] = await sql`select value from site_settings where key = 'lastFullBuild'`;
    expect(row.value).toEqual({ at: later.toISOString() });
    expect(await loadSettings(sql)).toEqual(DEFAULT_SETTINGS);
  }, 60_000);
});
