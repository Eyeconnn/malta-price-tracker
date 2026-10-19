// Cross-checks a dry-run sample against the live product pages.
// pnpm tsx src/cli/verify.ts out/dry-run-....json [--per-shop 3]
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { ShopFetcher } from '../http/fetcher.js';
import { userAgent } from '../env.js';
import { toCents } from '../util/normalise.js';
import type { NormalisedRecord } from '../types.js';

const { values, positionals } = parseArgs({ options: { 'per-shop': { type: 'string', default: '3' } }, allowPositionals: true });

/** Every price the page states in machine-readable form: JSON-LD offers, og/product meta, itemprop. */
export function pagePrices(htmlText: string): number[] {
  const $ = cheerio.load(htmlText);
  const found = new Set<number>();
  const add = (v: unknown) => {
    const c = toCents(v as string);
    if (c !== null && c > 0) found.add(c);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const walk = (n: unknown): void => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        const o = n as Record<string, unknown>;
        for (const k of ['price', 'lowPrice', 'highPrice']) if (o[k] !== undefined) add(o[k]);
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse($(el).text()));
    } catch {
      /* ignore broken JSON-LD */
    }
  });
  $('meta[property="og:price:amount"], meta[property="product:price:amount"], [itemprop="price"]').each((_, el) =>
    add($(el).attr('content') ?? $(el).text()),
  );
  $('[data-price-amount]').each((_, el) => add($(el).attr('data-price-amount')));
  return [...found];
}

async function main() {
  const file = positionals[0];
  if (!file) throw new Error('usage: verify <dry-run json>');
  const data = JSON.parse(await readFile(file, 'utf8')) as { shop: string; sample: NormalisedRecord[] }[];
  const perShop = Number(values['per-shop']);
  for (const s of data) {
    const fetcher = new ShopFetcher({ userAgent: userAgent() });
    // prefer records with a was price, then spread over the rest
    const picks = [...s.sample.filter((r) => r.was_price_cents), ...s.sample.filter((r) => !r.was_price_cents)]
      .filter((r) => r.url)
      .slice(0, perShop);
    for (const r of picks) {
      try {
        const res = await fetcher.get(r.url!, { accept: 'text/html' });
        const prices = pagePrices(res.text());
        const ok = r.price_cents !== null && prices.includes(r.price_cents);
        console.log(
          `${ok ? 'MATCH ' : 'CHECK '} ${s.shop} ${r.external_id} "${(r.title ?? '').slice(0, 40)}" ours ${r.price_cents}` +
            `${r.was_price_cents ? ` (was ${r.was_price_cents})` : ''} page [${prices.join(', ')}] ${r.url}`,
        );
      } catch (e) {
        console.log(`ERROR  ${s.shop} ${r.url}: ${(e as Error).message}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
