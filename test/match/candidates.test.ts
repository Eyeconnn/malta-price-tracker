// Candidate groups for the judge (design "Update 23 Oct, afternoon", point 1): listings likely to be one product,
// from the title-similarity groups and from model codes shared within the same or a neighbouring category, at most
// 12 per group, groups already matched by one barcode or part number left out, with a key and a fingerprint.
import { describe, expect, it } from 'vitest';
import { buildCandidates, candidateCodes, MAX_GROUP, spreadSample, type Listing } from '../../src/match/candidates.js';
import { candidateKey, fingerprint } from '../../src/match/fingerprint.js';

let nextId = 1;
const L = (shop: number, title: string, more: Partial<Listing> = {}): Listing => {
  const id = nextId++;
  return {
    id, shopId: shop, shopSlug: `shop${shop}`, groupKey: `g${id}`, title, brand: null, category: 'phones', categoryPath: null, gtin: null, mpn: null,
    priceCents: 10000, variantTitles: [], ...more,
  };
};
const titlesOf = (c: { members: Listing[] }) => c.members.map((m) => m.title).sort();

describe('buildCandidates', () => {
  it('groups the same phone at two shops by title similarity, and leaves single listings out', () => {
    const list = [
      L(1, 'Samsung Galaxy S23 256GB Phantom Black', { brand: 'Samsung' }),
      L(2, 'SAMSUNG Galaxy S23 256GB Black', { brand: 'SAMSUNG' }),
      L(3, 'Nokia 3310 Classic', { brand: 'Nokia' }),
    ];
    const c = buildCandidates(list);
    expect(c.map(titlesOf)).toEqual([['SAMSUNG Galaxy S23 256GB Black', 'Samsung Galaxy S23 256GB Phantom Black']]);
  });

  it('links listings sharing a model code across shops in the same or a neighbouring category, not in an unrelated one', () => {
    const list = [
      L(1, 'Samsung HW-Q600C Soundbar', { brand: 'Samsung', category: 'tv-audio' }),
      L(2, 'SAMSUNG HWQ600C 3.1.2 Ch Dolby Atmos', { brand: 'Samsung', category: 'phones' }),
      L(3, 'Samsung HW-Q600C replacement remote', { brand: 'Samsung', category: 'drinks' }),
    ];
    const c = buildCandidates(list);
    expect(c.map(titlesOf)).toEqual([['SAMSUNG HWQ600C 3.1.2 Ch Dolby Atmos', 'Samsung HW-Q600C Soundbar']]);
  });

  it('never links two brands through a shared code', () => {
    const list = [L(1, 'Spigen case for SM-S921B', { brand: 'Spigen' }), L(2, 'Samsung Galaxy S24 SM-S921B 128GB', { brand: 'Samsung' })];
    expect(buildCandidates(list)).toEqual([]);
  });

  it('keeps the colours one shop lists on their own as one candidate group', () => {
    const list = [
      L(1, 'JBL Tune 525BT Headphones Blue', { brand: 'JBL', category: 'tv-audio' }),
      L(1, 'JBL Tune 525BT Headphones Black', { brand: 'JBL', category: 'tv-audio' }),
    ];
    expect(buildCandidates(list).map(titlesOf)).toEqual([['JBL Tune 525BT Headphones Black', 'JBL Tune 525BT Headphones Blue']]);
  });

  it('splits a group of more than 12 by brand and model code, and keeps every part at most 12', () => {
    const list: Listing[] = [];
    for (let i = 0; i < 14; i++) list.push(L(i + 1, `Sony WH-1000XM5 Headphones ${i % 2 === 0 ? 'Black' : 'Silver'}`, { brand: 'Sony', category: 'tv-audio' }));
    for (let i = 0; i < 6; i++) list.push(L(i + 1, `Sony WH-1000XM4 Headphones Black`, { brand: 'Sony', category: 'tv-audio' }));
    const c = buildCandidates(list);
    expect(c.every((g) => g.members.length >= 2 && g.members.length <= MAX_GROUP)).toBe(true);
    expect(c.reduce((n, g) => n + g.members.length, 0)).toBe(20);
    // the XM4 listings are kept together, apart from the XM5 ones
    expect(c.some((g) => g.members.every((m) => m.title.includes('XM4')) && g.members.length === 6)).toBe(true);
  });

  it('leaves out groups whose every listing is already matched by one barcode or part number', () => {
    const a = L(1, 'Apple Watch Series 10 46mm', { brand: 'Apple', category: 'tv-audio', matchMethod: 'gtin', canonicalId: '7' });
    const b = L(2, 'Apple Watch Series 10 46mm Black', { brand: 'Apple', category: 'tv-audio', matchMethod: 'gtin', canonicalId: '7' });
    expect(buildCandidates([a, b])).toEqual([]);
    const c = L(3, 'APPLE Watch Series 10 46mm', { brand: 'Apple', category: 'tv-audio' });
    expect(buildCandidates([a, b, c]).map((g) => g.members.length)).toEqual([3]);
  });

  it('ignores a code shared by too many listings', () => {
    const list: Listing[] = [];
    for (let i = 0; i < 60; i++) list.push(L(i + 1, `Case model ABC1234 for phone ${i}x`, { brand: `Brand${i}` }));
    expect(buildCandidates(list)).toEqual([]);
  });

  it('gives each group a key from its members and a fingerprint of their titles', () => {
    const a = L(1, 'Samsung Galaxy S23 256GB Phantom Black', { brand: 'Samsung' });
    const b = L(2, 'SAMSUNG Galaxy S23 256GB Black', { brand: 'Samsung' });
    const [g] = buildCandidates([a, b]);
    expect(g.key).toBe(candidateKey([a, b]));
    expect(g.fingerprint).toBe(fingerprint([a, b]));
    expect(g.category).toBe('phones');
  });
});

describe('fingerprint and candidateKey', () => {
  const a = { shopId: 1, groupKey: 'x', title: 'Apple iPhone 15', variantTitles: ['128GB', '256GB'] };
  const b = { shopId: 2, groupKey: 'y', title: 'iPhone 15 Apple', variantTitles: [] };
  it('does not depend on member or variant order, and changes with a title, a variant or a member', () => {
    expect(fingerprint([a, b])).toBe(fingerprint([b, { ...a, variantTitles: ['256GB', '128GB'] }]));
    expect(fingerprint([a, b])).not.toBe(fingerprint([a, { ...b, title: 'iPhone 15 Pro Apple' }]));
    expect(fingerprint([a, b])).not.toBe(fingerprint([{ ...a, variantTitles: ['128GB'] }, b]));
    expect(candidateKey([a, b])).toBe(candidateKey([b, a]));
    expect(candidateKey([a, b])).toBe(candidateKey([a, { ...b, title: 'changed' }]));
    expect(candidateKey([a, b])).not.toBe(candidateKey([a, b, { shopId: 3, groupKey: 'z' }]));
    expect(candidateKey([a, b])).toMatch(/^c[0-9a-f]{32}$/);
  });
});

describe('candidateCodes', () => {
  it('reads codes of 4 or more characters and set numbers', () => {
    expect(candidateCodes('LEGO Technic 42115 Lamborghini')).toEqual(['42115']);
    expect(candidateCodes('Samsung Galaxy S24 SM-S921B')).toEqual(['s921b', 'sms921b']);
    expect(candidateCodes('Apple iPhone 15 128GB 2024')).toEqual([]);
  });
});

describe('spreadSample', () => {
  it('takes groups round-robin across categories, the same for a seed', () => {
    const groups = [
      ...Array.from({ length: 10 }, (_, i) => ({ key: `p${i}`, category: 'phones' })),
      ...Array.from({ length: 2 }, (_, i) => ({ key: `d${i}`, category: 'drinks' })),
    ];
    const s = spreadSample(groups, 4, 'pilot');
    expect(s.filter((g) => g.category === 'drinks')).toHaveLength(2);
    expect(s).toHaveLength(4);
    expect(spreadSample(groups, 4, 'pilot')).toEqual(s);
  });
});

describe('candidateCodes: feature codes are not model codes', () => {
  it('skips 5-in-1, IP68, USB3, Wi-Fi 6 and DDR5', () => {
    expect(candidateCodes('Shark SpeedStyle Pro 5-in-1 Hair Dryer HD752EU')).toEqual(['hd752eu']);
    expect(candidateCodes('Rugged phone IP68 USB3 WiFi6 DDR5 LPDDR5X PCIe4 HDMI2 Cat6 Gen4')).toEqual([]);
  });
});
