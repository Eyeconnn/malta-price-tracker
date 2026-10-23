// Match method judged (design "Update 23 Oct, afternoon", point 4): listings in one judged cluster (current
// fingerprint, not vetoed) are one product; GTIN and MPN groups keep priority and are never merged with each other.
import { describe, expect, it } from 'vitest';
import { assignMatches, type MatchInput } from '../../src/site/matching.js';

const it_ = (id: number, shopId: number, title: string, gtin: string | null = null): MatchInput => ({ id, shopId, gtin, mpn: null, title });

describe('assignMatches with judged clusters', () => {
  it('makes one product of a judged cluster, also of colours at one shop, keyed by its lowest id', () => {
    const items = [it_(1, 1, 'JBL Tune 525BT Blue'), it_(2, 1, 'JBL Tune 525BT Black'), it_(3, 2, 'Samsung S23'), it_(4, 3, 'Galaxy S23 256')];
    const m = assignMatches(items, { judged: [[1, 2], [4, 3]] });
    expect(m.get(1)).toEqual({ key: 'judged:1', method: 'judged' });
    expect(m.get(2)).toEqual({ key: 'judged:1', method: 'judged' });
    expect(m.get(3)).toEqual({ key: 'judged:3', method: 'judged' });
    expect(m.get(4)).toEqual({ key: 'judged:3', method: 'judged' });
  });

  it('keeps GTIN groups first and adds a judged listing to the one GTIN group whose judged members are all in its cluster', () => {
    const g = '036000291452';
    const items = [it_(1, 1, 'JBL Tune Buds 2', g), it_(2, 2, 'JBL TUNE BUDS 2', g), it_(3, 3, 'JBL Tune Buds 2 earbuds')];
    const m = assignMatches(items, { judged: [[1, 2, 3]] });
    expect(m.get(1)).toEqual({ key: 'gtin:00036000291452', method: 'gtin' });
    expect(m.get(3)).toEqual({ key: m.get(1)!.key, method: 'judged' });
  });

  it('never merges two GTIN groups; only the free listings of such a cluster may form their own group', () => {
    const items = [
      it_(1, 1, 'A', '036000291452'), it_(2, 2, 'A', '036000291452'),
      it_(3, 1, 'B', '4006381333931'), it_(4, 2, 'B', '4006381333931'),
      it_(5, 3, 'free one'), it_(6, 4, 'free two'), it_(7, 5, 'alone'),
    ];
    const m = assignMatches(items, { judged: [[1, 2, 3, 4, 5, 6], [1, 7]] });
    expect(m.get(1)!.method).toBe('gtin');
    expect(m.get(3)!.method).toBe('gtin');
    expect(m.get(1)!.key).not.toBe(m.get(3)!.key);
    expect(m.get(5)).toEqual({ key: 'judged:5', method: 'judged' });
    expect(m.get(6)).toEqual({ key: 'judged:5', method: 'judged' });
    // 7 was judged the same as a member of a GTIN group whose other member was not in that cluster
    expect(m.get(7)).toBeUndefined();
  });

  it('runs before the title rule, and without judged clusters nothing is judged', () => {
    const items = [it_(1, 1, 'Apple iPhone 15 128GB Black'), it_(2, 2, 'Apple iPhone 15 128GB Blue')];
    expect(assignMatches(items).get(1)!.method).toBe('title');
    expect(assignMatches(items, { judged: [[1, 2]] }).get(1)!.method).toBe('judged');
    expect(assignMatches(items, { judged: [[1, 99]] }).get(1)!.method).toBe('title');
  });
});

describe('assignMatches with judged clusters: barcodes and part numbers (review 23 Oct, C3)', () => {
  const m = (id: number, shopId: number, gtin: string | null, mpn: string | null = null): MatchInput => ({ id, shopId, gtin, mpn, title: 'Hot Wheels Monster Truck', brand: 'Mattel' });
  it('never groups two listings with different valid barcodes at different shops', () => {
    expect(assignMatches([m(1, 1, '5000112637922'), m(2, 2, '5449000000996')], { judged: [[1, 2]] }).size).toBe(0);
  });
  it('groups the colours one shop lists with their own barcodes', () => {
    const colour = (id: number, gtin: string, title: string): MatchInput => ({ ...m(id, 1, gtin), title });
    expect(assignMatches([colour(1, '5000112637922', 'Hot Wheels Monster Truck Red'), colour(2, '5449000000996', 'Hot Wheels Monster Truck Blue')], { judged: [[1, 2]] }).get(1)?.method).toBe('judged');
  });
  it('never adds a listing to a GTIN group whose barcode differs from its own', () => {
    const r = assignMatches([m(1, 1, '5000112637922'), m(2, 2, '5000112637922'), m(3, 3, '4006381333931')], { judged: [[1, 3]] });
    expect(r.get(3)).toBeUndefined();
  });
  it('never groups listings with different part numbers', () => {
    expect(assignMatches([m(1, 1, null, '82XM00ABUK'), m(2, 2, null, '83ER0012UK')], { judged: [[1, 2]] }).size).toBe(0);
    expect(assignMatches([m(1, 1, null, 'T500WHT'), m(2, 2, null, 'T500BLK')], { judged: [[1, 2]] }).get(1)?.method).toBe('judged');
  });
});

describe('assignMatches with judged clusters: re-review G4, G5, G7', () => {
  const X = '5000112637922';
  const Y = '5449000000996';
  const Z = '4006381333931';
  const m = (id: number, shopId: number, gtin: string | null, mpn: string | null = null, title = 'Hot Wheels Monster Truck'): MatchInput => ({ id, shopId, gtin, mpn, title, brand: 'Mattel' });
  it('G4: never joins an MPN group holding a listing with another barcode', () => {
    expect(assignMatches([m(1, 1, X, 'ABC12345'), m(2, 2, null, 'ABC12345'), m(3, 3, Y)], { judged: [[2, 3]] }).get(3)).toBeUndefined();
  });
  it('G5: never joins a GTIN group holding a listing with another part number', () => {
    expect(assignMatches([m(1, 1, X, 'ABC12345'), m(2, 2, X, null), m(3, 3, null, 'XYZ98765')], { judged: [[2, 3]] }).get(3)).toBeUndefined();
  });
  it('G7: a group left at one shop is kept only for colour or size variants of one title', () => {
    expect(assignMatches([m(1, 1, X), m(2, 1, Y), m(3, 2, Z)], { judged: [[1, 2, 3]] }).size).toBe(0);
    const r = assignMatches([m(1, 1, X, null, 'Hot Wheels Monster Truck Red'), m(2, 1, Y, null, 'Hot Wheels Monster Truck Blue'), m(3, 2, Z)], { judged: [[1, 2, 3]] });
    expect(r.get(1)?.method).toBe('judged');
    expect(r.get(3)).toBeUndefined();
  });
});
