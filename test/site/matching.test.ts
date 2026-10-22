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

  it('matches by GTIN across shops, ignoring leading zeros and formatting', () => {
    const m = assignMatches([
      item(1, 10, 'Thing one', { gtin: '0194253397755' }),
      item(2, 20, 'Totally different words', { gtin: '194253397755' }),
      item(3, 30, 'Other', { gtin: '194253397762' }),
    ]);
    expect(m.get(1)).toEqual({ key: 'gtin:194253397755', method: 'gtin' });
    expect(m.get(2)).toEqual({ key: 'gtin:194253397755', method: 'gtin' });
    expect(m.has(3)).toBe(false);
  });

  it('matches by normalised MPN across shops', () => {
    const m = assignMatches([
      item(1, 10, 'Razer Mouse', { mpn: 'RZ03-05930100' }),
      item(2, 20, 'Gaming pointer', { mpn: 'rz0305930100' }),
    ]);
    expect(m.get(1)).toEqual({ key: 'mpn:rz0305930100', method: 'mpn' });
    expect(m.get(2)).toEqual({ key: 'mpn:rz0305930100', method: 'mpn' });
  });

  it('ignores MPNs shorter than 5 characters', () => {
    expect(assignMatches([item(1, 10, 'A', { mpn: 'AB-1' }), item(2, 20, 'B', { mpn: 'ab1' })]).size).toBe(0);
  });

  it('never matches two items from one shop', () => {
    const m = assignMatches([
      item(1, 10, 'Apple iPhone 17 256GB'),
      item(2, 10, 'Apple iPhone 17 256GB'),
      item(3, 10, 'x', { gtin: '194253397755' }),
      item(4, 10, 'y', { gtin: '194253397755' }),
      item(5, 10, 'z', { mpn: 'ABCDE12345' }),
      item(6, 10, 'w', { mpn: 'abcde-12345' }),
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
      item(1, 10, 'Apple iPhone 17 256GB', { gtin: '194253397755', mpn: 'MPN-12345' }),
      item(2, 20, 'Apple iPhone 17 256GB', { gtin: '194253397755', mpn: 'OTHER-99999' }),
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

  it('handles a large catalogue quickly', () => {
    const items: MatchInput[] = [];
    for (let i = 0; i < 20000; i++) items.push(item(i + 1, (i % 5) + 1, `Brand${i % 997} Model ${i % 4001} edition widget ${i}x`));
    const t = Date.now();
    assignMatches(items);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
