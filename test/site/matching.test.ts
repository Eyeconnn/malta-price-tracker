import { describe, expect, it } from 'vitest';
import { assignMatches, nameMatch, sameTitle, titleTokens, type MatchInput } from '../../src/site/matching.js';
import { APART, type PairListing, TOGETHER } from './review-pairs.js';

function item(id: number, shopId: number, title: string, over: Partial<MatchInput> = {}): MatchInput {
  return { id, shopId, gtin: null, mpn: null, title, ...over };
}

describe('titleTokens', () => {
  it('lowercases, splits on punctuation and drops colours, filler and one-letter words', () => {
    expect(titleTokens('APPLE iPhone 17 256GB-Storage 8GB Smartphone, Black')).toEqual(['apple', 'iphone', '17', '256gb', '8gb']);
    expect(titleTokens('')).toEqual([]);
  });
});

describe('sameTitle', () => {
  it('matches the same phone worded differently', () => {
    expect(sameTitle(titleTokens('Apple iPhone 17 256GB – White'), titleTokens('APPLE iPhone 17 256GB-Storage 8GB Smartphone, Black'))).toBe(true);
  });

  it('requires model words to agree', () => {
    expect(sameTitle(titleTokens('iPhone 17 Pro 256GB'), titleTokens('iPhone 17 256GB'))).toBe(false);
    expect(sameTitle(titleTokens('iPhone 17 Pro 256GB'), titleTokens('iPhone 17 Pro 256GB Silver'))).toBe(true);
  });

  it('requires numbers to agree', () => {
    expect(sameTitle(titleTokens('iPhone 17 256GB'), titleTokens('iPhone 17 512GB'))).toBe(false);
  });

  it('requires a Jaccard similarity of at least 0.5', () => {
    expect(sameTitle(['a1', 'x', 'y', 'z'], ['a1', 'p', 'q', 'r'])).toBe(false);
    expect(sameTitle(['a1', 'x'], ['a1', 'x', 'y'])).toBe(true);
  });
});

describe('assignMatches', () => {
  it('matches similar titles across shops', () => {
    const m = assignMatches([
      item(1, 10, 'Apple iPhone 17 256GB – White'),
      item(2, 20, 'APPLE iPhone 17 256GB-Storage 8GB Smartphone, Black'),
    ]);
    expect(m.get(1)).toEqual({ key: 'title:1', method: 'title' });
    expect(m.get(2)).toEqual({ key: 'title:1', method: 'title' });
  });

  it('does not match a Pro with a non-Pro', () => {
    const m = assignMatches([item(1, 10, 'iPhone 17 Pro 256GB'), item(2, 20, 'iPhone 17 256GB')]);
    expect(m.size).toBe(0);
  });

  it('matches by valid GTIN across shops, padded to 14 digits', () => {
    const m = assignMatches([
      item(1, 10, 'Thing one', { gtin: '036000291452' }),
      item(2, 20, 'Totally different words', { gtin: '0036000291452' }),
      item(3, 30, 'Other', { gtin: '4006381333931' }),
    ]);
    expect(m.get(1)).toEqual({ key: 'gtin:00036000291452', method: 'gtin' });
    expect(m.get(2)).toEqual({ key: 'gtin:00036000291452', method: 'gtin' });
    expect(m.has(3)).toBe(false);
  });

  it('ignores GTINs with a bad check digit', () => {
    const m = assignMatches([
      item(1, 10, 'Thing one', { gtin: '4006381333932' }),
      item(2, 20, 'Totally different words', { gtin: '4006381333932' }),
    ]);
    expect(m.size).toBe(0);
  });

  it('matches by normalised MPN across shops that share a brand word', () => {
    const m = assignMatches([
      item(1, 10, 'Razer DeathAdder Mouse', { mpn: 'RZ03-05930100' }),
      item(2, 20, 'RAZER gaming pointer', { mpn: 'rz0305930100' }),
    ]);
    expect(m.get(1)).toEqual({ key: 'mpn:rz0305930100', method: 'mpn' });
    expect(m.get(2)).toEqual({ key: 'mpn:rz0305930100', method: 'mpn' });
  });

  it('does not match a shared MPN when the titles share no word', () => {
    const m = assignMatches([
      item(1, 10, 'Razer DeathAdder Mouse', { mpn: 'RZ03-05930100' }),
      item(2, 20, 'Garden hose reel', { mpn: 'rz0305930100' }),
    ]);
    expect(m.size).toBe(0);
  });

  it('does not treat a shared number as a shared word for MPN groups', () => {
    const m = assignMatches([
      item(1, 10, 'Alpha 256GB', { mpn: 'ABCDE-12345' }),
      item(2, 20, 'Omega 256GB', { mpn: 'abcde12345' }),
    ]);
    expect(m.size).toBe(0);
  });

  it('ignores MPNs shorter than 5 characters', () => {
    expect(assignMatches([item(1, 10, 'A', { mpn: 'AB-1' }), item(2, 20, 'B', { mpn: 'ab1' })]).size).toBe(0);
  });

  it('never matches placeholder MPNs such as N/A or 0000000', () => {
    const titles = ['Razer DeathAdder Mouse', 'RAZER gaming pointer'];
    for (const mpn of ['N/A', 'n.a.', 'NONE', 'Default', 'Not Applicable', 'TBC', 'tba', 'Unknown', '0000000', '000-00-00', 'XXXXX', '11111']) {
      const m = assignMatches([item(1, 10, titles[0], { mpn }), item(2, 20, titles[1], { mpn })]);
      expect(m.size, mpn).toBe(0);
    }
  });

  it('never matches two items from one shop', () => {
    const m = assignMatches([
      item(1, 10, 'Apple iPhone 17 256GB'),
      item(2, 10, 'Apple iPhone 17 256GB'),
      item(3, 10, 'x', { gtin: '036000291452' }),
      item(4, 10, 'y', { gtin: '036000291452' }),
      item(5, 10, 'zeta', { mpn: 'ABCDE12345' }),
      item(6, 10, 'zeta', { mpn: 'abcde-12345' }),
    ]);
    expect(m.size).toBe(0);
  });

  it('groups same-shop variants together with the other shop item', () => {
    const m = assignMatches([
      item(1, 10, 'Apple iPhone 17 256GB'),
      item(2, 10, 'Apple iPhone 17 256GB'),
      item(3, 20, 'Apple iPhone 17 256GB Black'),
    ]);
    expect([...m.keys()].sort()).toEqual([1, 2, 3]);
    expect(new Set([...m.values()].map((v) => v.key)).size).toBe(1);
  });

  it('prefers GTIN over MPN over title and does not regroup an item', () => {
    const m = assignMatches([
      item(1, 10, 'Apple iPhone 17 256GB', { gtin: '036000291452', mpn: 'MPN-12345' }),
      item(2, 20, 'Apple iPhone 17 256GB', { gtin: '036000291452', mpn: 'OTHER-99999' }),
      item(3, 30, 'Apple iPhone 17 256GB', { mpn: 'mpn12345' }),
      item(4, 40, 'Apple iPhone 17 256GB'),
    ]);
    expect(m.get(1)?.method).toBe('gtin');
    expect(m.get(2)?.method).toBe('gtin');
    expect(m.get(3)).toEqual({ key: 'title:3', method: 'title' });
    expect(m.get(4)).toEqual({ key: 'title:3', method: 'title' });
  });

  it('leaves titles without numbers unmatched', () => {
    expect(assignMatches([item(1, 10, 'Gaming Mouse Pro'), item(2, 20, 'Gaming Mouse Pro')]).size).toBe(0);
  });

  it('handles a 2000-character title', () => {
    const long = 'Apple iPhone 17 256GB ' + Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ');
    expect(long.length).toBeGreaterThan(2000);
    const started = Date.now();
    const m = assignMatches([item(1, 10, long), item(2, 20, 'Apple iPhone 17 256GB'), item(3, 30, long)]);
    expect(m).toBeInstanceOf(Map);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('matches a realistic 100k item catalogue quickly', () => {
    // ~22k products sold by 4 to 5 shops; storage sizes and generation numbers are shared by a fifth to a third of all items.
    const letters = (n: number, len: number) => {
      let s = '';
      for (let i = 0; i < len; i++) {
        s = String.fromCharCode(97 + (n % 26)) + s;
        n = Math.floor(n / 26);
      }
      return s;
    };
    const colours = ['Black', 'White', 'Silver', 'Blue'];
    const storage = ['128GB', '256GB', '512GB'];
    const items: MatchInput[] = [];
    const ids: number[][] = [];
    let id = 1;
    for (let p = 0; p < 22000; p++) {
      const brand = 'br' + letters(p % 300, 3);
      const rest = Math.floor(p / 300);
      const gen = 13 + (rest % 5);
      const size = storage[Math.floor(rest / 5) % 3];
      const line = 'ln' + letters(Math.floor(rest / 15), 2);
      const code = 'mk' + (1000 + p);
      const shops = 4 + (p % 2);
      const group: number[] = [];
      for (let s = 0; s < shops; s++) {
        const colour = colours[(p + s) % 4];
        const title = [
          `${brand} ${line} ${gen} ${size} ${code} ${colour}`,
          `${brand.toUpperCase()} ${line} ${gen}, ${size} Smartphone ${colour} ${code}`,
          `${brand} ${line} (${code}) ${gen} ${size}-Storage`,
          `${colour} ${brand} ${line} ${gen} ${size} ${code}`,
          `${brand} ${line} ${gen} ${size} ${code} with warranty`,
        ][s];
        items.push(item(id, s + 1, title));
        group.push(id++);
      }
      ids.push(group);
    }
    expect(items.length).toBeGreaterThan(95000);

    const t0 = performance.now();
    const m = assignMatches(items);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(5000);
    const g = ids[12345];
    expect(m.get(g[0])?.method).toBe('title');
    expect(new Set(g.map((x) => m.get(x)?.key)).size).toBe(1);
    expect(m.get(ids[12345][0])?.key).not.toBe(m.get(ids[12346][0])?.key);
    expect(m.size).toBeGreaterThan(items.length * 0.95);
  });
});

describe('assignMatches brand check (final review I2)', () => {
  const title = 'Laptop 15.6 Intel Core i5-1235U 16GB 512GB SSD';

  it('does not title-match two rows whose brands differ', () => {
    const m = assignMatches([item(1, 10, title, { brand: 'Acer' }), item(2, 20, title, { brand: 'Lenovo' })]);
    expect(m.size).toBe(0);
  });

  it('compares brands lowercased and trimmed, and lets a row without a brand match', () => {
    const same = assignMatches([item(1, 10, title, { brand: 'Acer' }), item(2, 20, title, { brand: ' ACER ' })]);
    expect(same.get(1)?.method).toBe('title');
    expect(same.get(2)?.key).toBe(same.get(1)?.key);
    const unknown = assignMatches([item(1, 10, title, { brand: 'Acer' }), item(2, 20, title, { brand: null })]);
    expect(unknown.get(2)?.key).toBe(unknown.get(1)?.key);
  });

  it('keeps an Acer and a Lenovo apart even when both look like a brandless first row', () => {
    const m = assignMatches([item(1, 10, title), item(2, 20, title, { brand: 'Acer' }), item(3, 30, title, { brand: 'Lenovo' })]);
    const k2 = m.get(2)?.key;
    const k3 = m.get(3)?.key;
    expect(k2 === undefined || k3 === undefined || k2 !== k3).toBe(true);
  });
});

describe('assignMatches by clean name and key specs (design Part 3, "name + specs")', () => {
  /** A row with an accepted clean name; brand is the reliable brand (null when the row has none). */
  const named = (
    id: number,
    shopId: number,
    name: string,
    attrs: Record<string, unknown>,
    o: { category?: string; brand?: string | null; gtin?: string; title?: string; label?: string | null; variants?: number } = {},
  ): MatchInput => {
    const brand = o.brand === undefined ? 'Samsung' : o.brand;
    const title = o.title ?? `shop listing ${id}`;
    return item(id, shopId, title, {
      gtin: o.gtin ?? null,
      brand,
      name: nameMatch(name, o.category ?? 'phones', attrs, brand, { title, variantLabel: o.label ?? null, variantCount: o.variants ?? 1 }),
    });
  };
  const S25 = 'Samsung Galaxy S25 Ultra Smartphone';

  it('matches the same phone at two shops, written differently', () => {
    const m = assignMatches([named(1, 10, S25, { storage_gb: 256, ram_gb: 12 }), named(2, 20, 'SAMSUNG Galaxy S25-Ultra smartphone', { storage_gb: 256, ram_gb: 12 })]);
    expect(m.get(1)).toEqual({ key: 'name:1', method: 'name' });
    expect(m.get(2)).toEqual({ key: 'name:1', method: 'name' });
  });

  it('never matches 256GB with 512GB', () => {
    expect(assignMatches([named(1, 10, S25, { storage_gb: 256 }), named(2, 20, S25, { storage_gb: 512 })]).size).toBe(0);
  });

  it('never matches different brands, even with the same name', () => {
    const m = assignMatches([named(1, 10, 'Galaxy Case 25', {}, { brand: 'Samsung' }), named(2, 20, 'Galaxy Case 25', {}, { brand: 'Spigen' })]);
    expect(m.size).toBe(0);
  });

  it('a brand on one side only must be in the shared name', () => {
    const inName = assignMatches([named(1, 10, S25, {}, { brand: 'Samsung' }), named(2, 20, S25, {}, { brand: null })]);
    expect(inName.get(2)?.key).toBe('name:1');
    const notInName = assignMatches([named(1, 10, 'Galaxy S25 Ultra', {}, { brand: 'Samsung' }), named(2, 20, 'Galaxy S25 Ultra', {}, { brand: null })]);
    expect(notInName.size).toBe(0);
    const neither = assignMatches([named(1, 10, 'Galaxy S25 Ultra', {}, { brand: null }), named(2, 20, 'Galaxy S25 Ultra', {}, { brand: null })]);
    expect(neither.get(2)?.method).toBe('name');
  });

  it('matches when one side does not give the storage', () => {
    const m = assignMatches([named(1, 10, S25, { storage_gb: 256, ram_gb: 12 }), named(2, 20, S25, { ram_gb: 12 })]);
    expect(m.get(2)).toEqual({ key: 'name:1', method: 'name' });
  });

  it('a listing without storage that fits both a 256GB and a 512GB product joins neither', () => {
    const m = assignMatches([
      named(1, 10, S25, { storage_gb: 256 }),
      named(2, 20, S25, { storage_gb: 256 }),
      named(3, 10, S25, { storage_gb: 512 }),
      named(4, 20, S25, { storage_gb: 512 }),
      named(5, 30, S25, {}),
    ]);
    expect(m.get(1)?.key).toBe(m.get(2)?.key);
    expect(m.get(3)?.key).toBe(m.get(4)?.key);
    expect(m.get(1)?.key).not.toBe(m.get(3)?.key);
    expect(m.has(5)).toBe(false);
  });

  it('never matches a pack of 6 with a pack of 12', () => {
    const drink = (id: number, shop: number, pack: number) =>
      named(id, shop, 'Heineken Lager Beer Can 330ml', { volume_ml: 330, pack_count: pack }, { category: 'drinks', brand: 'Heineken' });
    expect(assignMatches([drink(1, 10, 6), drink(2, 20, 12)]).size).toBe(0);
    expect(assignMatches([drink(1, 10, 6), drink(2, 20, 6)]).get(2)?.method).toBe('name');
  });

  it('colour is never part of identity: the colours of one product group together across shops', () => {
    const m = assignMatches([
      named(1, 10, S25, { storage_gb: 512, colour: ['grey'] }),
      named(2, 10, S25, { storage_gb: 512, colour: ['blue'] }),
      named(3, 20, S25, { storage_gb: 512, colour: ['black'] }),
    ]);
    expect(new Set([1, 2, 3].map((id) => m.get(id)?.key))).toEqual(new Set(['name:1']));
  });

  it('groups the colours of one shop that lists each colour on its own (same name, brand and specs)', () => {
    const jbl = (id: number, colour: string) =>
      named(id, 10, 'JBL Tune 525BT On-Ear Wireless Headphones', { colour: [colour], wireless: 'yes' }, { category: 'tv-audio', brand: 'JBL' });
    const m = assignMatches([jbl(1, 'blue'), jbl(2, 'black')]);
    expect(m.get(1)).toEqual({ key: 'name:1', method: 'name' });
    expect(m.get(2)).toEqual({ key: 'name:1', method: 'name' });
    expect(assignMatches([named(1, 10, S25, { storage_gb: 256 }), named(2, 10, S25, { storage_gb: 256 })]).get(2)?.method).toBe('name');
  });

  it('keeps 256GB and 512GB of one shop apart, and a listing of that shop without the storage too', () => {
    expect(assignMatches([named(1, 10, S25, { storage_gb: 256 }), named(2, 10, S25, { storage_gb: 512 })]).size).toBe(0);
    // within one shop the specs must be the same, not only agree where both have them
    expect(assignMatches([named(1, 10, S25, { storage_gb: 256 }), named(2, 10, S25, {})]).size).toBe(0);
    // and a different brand at the same shop stays apart
    expect(assignMatches([named(1, 10, 'Galaxy Case 25', {}, { brand: 'Samsung' }), named(2, 10, 'Galaxy Case 25', {}, { brand: 'Spigen' })]).size).toBe(0);
  });

  it('a listing without a GTIN joins the GTIN product whose named listings share its name and specs', () => {
    const m = assignMatches([
      named(1, 10, S25, { storage_gb: 256 }, { gtin: '036000291452' }),
      named(2, 20, S25, { storage_gb: 256 }, { gtin: '036000291452' }),
      item(3, 30, 'no clean name yet', { gtin: '036000291452' }),
      named(4, 40, S25, { storage_gb: 256 }),
    ]);
    expect(m.get(1)).toEqual({ key: 'gtin:00036000291452', method: 'gtin' });
    expect(m.get(3)?.method).toBe('gtin');
    expect(m.get(4)).toEqual({ key: 'gtin:00036000291452', method: 'name' });
  });

  it('does not join a GTIN product whose named listings disagree', () => {
    const m = assignMatches([
      named(1, 10, S25, { storage_gb: 256 }, { gtin: '036000291452' }),
      named(2, 20, 'Samsung Galaxy S25 Ultra Case', {}, { gtin: '036000291452' }),
      named(4, 40, S25, { storage_gb: 256 }),
    ]);
    expect(m.get(1)?.method).toBe('gtin');
    expect(m.has(4)).toBe(false);
  });

  it('never merges two GTIN products, and a listing that fits both joins neither', () => {
    const m = assignMatches([
      named(1, 10, S25, { storage_gb: 256 }, { gtin: '036000291452' }),
      named(2, 20, S25, { storage_gb: 256 }, { gtin: '036000291452' }),
      named(3, 10, S25, { storage_gb: 256 }, { gtin: '4006381333931' }),
      named(4, 20, S25, { storage_gb: 256 }, { gtin: '4006381333931' }),
      named(5, 30, S25, { storage_gb: 256 }),
    ]);
    expect(m.get(1)?.key).toBe('gtin:00036000291452');
    expect(m.get(3)?.key).toBe('gtin:04006381333931');
    expect(m.has(5)).toBe(false);
  });

  it('a name match is not title-matched again; rows without a clean name still title-match', () => {
    const m = assignMatches([
      named(1, 10, S25, { storage_gb: 256 }, { title: 'Samsung Galaxy S25 Ultra 256GB' }),
      named(2, 20, S25, { storage_gb: 256 }, { title: 'SAMSUNG S25 Ultra 256GB' }),
      item(3, 30, 'Samsung Galaxy S25 Ultra 256GB Black'),
      item(4, 40, 'Samsung Galaxy S25 Ultra 256GB'),
    ]);
    expect(m.get(1)?.method).toBe('name');
    expect(m.get(3)).toEqual({ key: 'title:3', method: 'title' });
    expect(m.get(4)?.key).toBe('title:3');
  });

  it('the title rule never groups two listings the name rule keeps apart', () => {
    const drink = (id: number, shop: number, pack: number, title: string) =>
      named(id, shop, 'Heineken Lager Beer Can 330ml', { volume_ml: 330, pack_count: pack }, { category: 'drinks', brand: 'Heineken', title });
    const m = assignMatches([drink(1, 10, 6, 'Heineken Lager 6 x 330ml'), drink(2, 20, 12, 'HEINEKEN LAGER CANS 330ML (12 PACK)')]);
    expect(m.size).toBe(0);
    // without clean names the same titles are a title match ("possibly the same")
    expect(assignMatches([item(1, 10, 'Heineken Lager 6 x 330ml'), item(2, 20, 'HEINEKEN LAGER CANS 330ML (12 PACK)')]).get(2)?.method).toBe('title');
  });

  it('leaves a name shared by too many listings unmatched (bounded work)', () => {
    const many = Array.from({ length: 300 }, (_, i) => named(i + 1, i + 1, 'Gift Card', {}, { brand: null }));
    expect(assignMatches(many).size).toBe(0);
  });

  it('matches 100k named listings quickly', () => {
    const items: MatchInput[] = [];
    for (let p = 0; p < 25000; p++) {
      for (let s = 0; s < 4; s++) {
        items.push(named(p * 4 + s + 1, s + 1, `Brand${p % 400} Model ${p}`, s === 3 ? {} : { storage_gb: 128 }, { brand: `Brand${p % 400}` }));
      }
    }
    const t0 = performance.now();
    const m = assignMatches(items);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(m.get(5)?.key).toBe(m.get(8)?.key);
    expect(m.get(1)?.key).not.toBe(m.get(5)?.key);
    expect(m.size).toBe(items.length);
  });

  it('keeps a pre-owned game apart from a new one (review C1)', () => {
    const game = (id: number, shop: number, name: string, title: string) => named(id, shop, name, {}, { category: 'gaming', brand: null, title });
    expect(assignMatches([game(1, 10, 'Far Cry Instincts (Xbox)', 'Far Cry Instincts (Xbox)'), game(2, 20, 'Far Cry Instincts (Xbox) (Pre-owned)', 'Far Cry Instincts (Xbox) (Pre-owned)')]).size).toBe(0);
    // a name stored before the rule, without the condition: the shop title still tells
    expect(assignMatches([game(1, 10, 'Far Cry Instincts (Xbox)', 'Far Cry Instincts (Xbox)'), game(2, 20, 'Far Cry Instincts (Xbox)', 'Far Cry Instincts (Xbox) (Pre-owned)')]).size).toBe(0);
    expect(assignMatches([game(1, 10, 'Far Cry Instincts (Xbox) Pre-owned', 'x'), game(2, 20, 'Far Cry Instincts (Xbox) (Preowned)', 'y')]).get(2)?.method).toBe('name');
  });

  it('keeps gift cards of different values apart, also at one shop (review C1)', () => {
    const card = (id: number, shop: number, title: string) => named(id, shop, 'Steam Gift Card', {}, { category: 'gaming', brand: 'Steam', title });
    expect(assignMatches([card(1, 10, 'Steam Gift Card €20'), card(2, 20, 'Steam Gift Card €50')]).size).toBe(0);
    expect(assignMatches([card(1, 10, 'Steam Gift Card €20'), card(2, 10, 'Steam Gift Card €50')]).size).toBe(0);
    expect(assignMatches([card(1, 10, 'Steam Gift Card €20'), card(2, 20, 'Steam Gift Card')]).size).toBe(0);
    expect(assignMatches([card(1, 10, 'Steam Gift Card €20'), card(2, 20, 'STEAM GIFT CARD 20 EUR')]).get(2)?.method).toBe('name');
  });

  it('keeps a refurbished grade A iPhone apart from a new one (review C1)', () => {
    const m = assignMatches([
      named(1, 10, 'Apple iPhone 13 Refurbished Grade A', { storage_gb: 128 }, { brand: 'Apple', title: 'Apple iPhone 13 128GB Refurbished Grade A' }),
      named(2, 20, 'Apple iPhone 13', { storage_gb: 128 }, { brand: 'Apple', title: 'Apple iPhone 13 128GB' }),
      named(3, 30, 'Apple iPhone 13', { storage_gb: 128 }, { brand: 'Apple', title: 'Apple iPhone 13 128GB (Refurbished, Grade A)' }),
    ]);
    // the new one is never linked, not even as possibly the same; the two refurbished grade A listings may be
    expect(m.has(2)).toBe(false);
    expect(m.get(1)?.method).not.toBe('name');
    expect(m.get(1)?.key).toBe(m.get(3)?.key);
  });

  it('a listing with several variants matches only when it has every identity spec the other has (review C2a)', () => {
    const group = named(1, 10, S25, {}, { label: '256GB, 512GB', variants: 2 });
    const only512 = named(2, 20, S25, { storage_gb: 512 }, { label: '512GB' });
    expect(assignMatches([group, only512]).size).toBe(0);
    const group512 = named(1, 10, S25, { storage_gb: 512 }, { label: '512GB, Black, Grey', variants: 2 });
    expect(assignMatches([group512, only512]).get(1)?.method).toBe('name');
  });

  it('numbers with a unit in the variant label are identity too, unless the attributes give them (review C2b)', () => {
    expect(assignMatches([named(1, 10, S25, {}, { label: '256GB' }), named(2, 20, S25, {}, { label: '512GB' })]).size).toBe(0);
    expect(assignMatches([named(1, 10, S25, {}, { label: '256GB' }), named(2, 20, S25, {}, { label: 'Black' })]).size).toBe(0);
    expect(assignMatches([named(1, 10, S25, {}, { label: '256GB, Black' }), named(2, 20, S25, {}, { label: '256GB, Grey' })]).get(2)?.method).toBe('name');
    expect(assignMatches([named(1, 10, S25, { storage_gb: 256 }, { label: '256GB, Black' }), named(2, 20, S25, { storage_gb: 256 }, { label: 'Grey' })]).get(2)?.method).toBe('name');
  });

  it('forms the same clusters whatever the order of the listings (review I1)', () => {
    const listings = [
      named(1, 1, S25, { storage_gb: 256 }),
      named(2, 2, S25, { storage_gb: 256 }),
      named(3, 3, S25, { storage_gb: 512 }),
      named(4, 4, S25, { ram_gb: 12 }),
    ];
    const perms = (a: MatchInput[]): MatchInput[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
    for (const order of perms(listings)) {
      const m = assignMatches(order);
      const got = [1, 2, 3, 4].map((id) => m.get(id)?.key ?? null);
      expect(got, order.map((o) => o.id).join(',')).toEqual(['name:1', 'name:1', null, null]);
    }
  });

  it('W{ram 12}, X{256GB}, Y{512GB}: none matches, in every order (review I1)', () => {
    const listings = [named(1, 1, S25, { ram_gb: 12 }), named(2, 2, S25, { storage_gb: 256 }), named(3, 3, S25, { storage_gb: 512 })];
    const perms = (a: MatchInput[]): MatchInput[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
    for (const order of perms(listings)) expect(assignMatches(order).size, order.map((o) => o.id).join(',')).toBe(0);
  });

  it('only compares clean names within one category (review I2)', () => {
    const m = assignMatches([named(1, 10, 'Galaxy Watch Strap 20', {}, { category: 'phones' }), named(2, 20, 'Galaxy Watch Strap 20', {}, { category: 'fashion' })]);
    expect(m.size).toBe(0);
  });
});

describe('name matching: the re-review pairs', () => {
  const input = (l: PairListing, id: number): MatchInput => ({
    id,
    shopId: l.shop === 'alpha' ? 1 : 2,
    gtin: null,
    mpn: null,
    title: l.title,
    brand: l.brand,
    name: nameMatch(l.name, l.category, l.attrs, l.brand, { title: l.title, variantLabel: l.label, variantCount: 1 }),
  });

  for (const { what, pair } of APART) {
    it(`keeps apart: ${what}`, () => {
      const m = assignMatches([input(pair[0], 1), input(pair[1], 2)]);
      expect(m.get(1)?.method).not.toBe('name');
      expect(m.get(2)?.method).not.toBe('name');
    });
  }

  for (const { what, pair } of TOGETHER) {
    it(`still matches: ${what}`, () => {
      const m = assignMatches([input(pair[0], 1), input(pair[1], 2)]);
      expect(m.get(1)).toEqual({ key: 'name:1', method: 'name' });
      expect(m.get(2)?.key).toBe('name:1');
    });
  }
});
