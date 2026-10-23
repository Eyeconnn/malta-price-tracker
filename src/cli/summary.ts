// Daily summary email: latest full run per active shop over the last 26 hours.
import { db, closeDb } from '../db.js';
import { sendEmail } from '../email.js';
import { photoStorage } from '../pipeline/images.js';
import { imageStorageLine, WARN_BYTES } from '../pipeline/photo.js';
import { closeStaleRuns } from '../pipeline/store.js';

async function main() {
  await closeStaleRuns();
  const rows = await db()<
    { slug: string; name: string; adapter: string; status: string | null; products_seen: number | null; flagged: number; started_at: Date | null; notes: string | null }[]
  >`
    select s.slug, s.name, s.adapter, r.status, r.products_seen, r.started_at, r.notes,
      (select count(*)::int from price_observations po where po.run_id = r.id and po.review_flag is not null) as flagged
    from shops s
    left join lateral (
      select * from scrape_runs r where r.shop_id = s.id and r.kind = 'full' and r.started_at > now() - interval '26 hours'
      order by r.started_at desc limit 1
    ) r on true
    where s.active and s.adapter <> 'headless'
    order by r.status nulls first, s.slug`;
  const count = (st: string | null) => rows.filter((r) => r.status === st).length;
  const missing = rows.filter((r) => r.status === null);
  const total = rows.reduce((a, r) => a + (r.products_seen ?? 0), 0);
  const [{ products }] = await db()<{ products: number }[]>`select count(*)::int as products from products`;
  const [{ bytes }] = await db()<{ bytes: string }[]>`select pg_database_size(current_database())::text as bytes`;
  const mb = Math.round(Number(bytes) / 1e6);
  // Neon Build plan includes 5 GB (DB_LIMIT_MB to change); at 80% it is time to shrink the data
  const limitMb = Number(process.env.DB_LIMIT_MB ?? 5000);
  const full = mb >= limitMb * 0.8;
  const storage = `Database size: ${mb} MB of ${limitMb} MB (${Math.round((100 * mb) / limitMb)}%)${full ? '  WARNING: over 80%, time to shrink the data (collapse same-price variants, slim product rows)' : ''}.`;
  const photos = await photoStorage(db());
  const r2Full = photos.bytes + photos.snapshotBytes >= WARN_BYTES;
  const lines = rows.map(
    (r) =>
      `${(r.status ?? 'NO RUN').padEnd(8)} ${r.slug.padEnd(14)} ${String(r.products_seen ?? '').padStart(7)} products` +
      `${r.flagged ? `, ${r.flagged} flagged` : ''}${r.notes ? `  (${r.notes.slice(0, 140)})` : ''}`,
  );
  const subject =
    `[price tracker] daily: ${count('ok')} ok, ${count('partial')} partial, ${count('failed')} failed` +
    `${missing.length ? `, ${missing.length} missing` : ''}, ${total.toLocaleString('en')} prices${full ? ', DB over 80%' : ''}${r2Full ? ', R2 over 8 GB' : ''}`;
  const text = [
    `Shops: ${count('ok')} ok, ${count('partial')} partial, ${count('failed')} failed, ${missing.length} with no run in the last 26 hours.`,
    `Prices recorded in the latest runs: ${total.toLocaleString('en')}. Products in the database: ${products.toLocaleString('en')}.`,
    storage,
    imageStorageLine(photos.count, photos.bytes, photos.snapshotBytes),
    '',
    ...lines,
  ].join('\n');
  await sendEmail(subject, text);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
