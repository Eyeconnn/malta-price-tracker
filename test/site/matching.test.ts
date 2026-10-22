import { describe, expect, it } from 'vitest';
import { assignMatches, sameTitle, titleTokens, type MatchInput } from '../../src/site/matching.js';

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
