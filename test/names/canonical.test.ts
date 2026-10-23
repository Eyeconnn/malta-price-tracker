// Canonical names (design "Update 23 Oct"): built by code from the identity fields Claude returns, never from its
// free text, and checked against the shop title. The answers are fixtures: no Claude call.
import { describe, expect, it } from 'vitest';
import { canonicalName, checkCanonical, parseCanonicalPatterns } from '../../src/names/canonical.js';

type Listing = { title: string; brand: string | null; category: string; attrs: Record<string, unknown> };
const L = (category: string, title: string, brand: string | null, attrs: Record<string, unknown>): Listing => ({ title, brand, category, attrs });

/** The canonical name a listing gets: the checker must accept it. */
function canon(l: Listing): string {
  const r = checkCanonical({ title: l.title, brand: l.brand }, l.category, l.attrs);
  if (!r.ok) throw new Error(`${l.title}: ${r.reason}`);
  return r.canonical;
}

const phone = (title: string, brand: string, attrs: Record<string, unknown>) => L('phones', title, brand, { brand, ...attrs });

/** Every pair the three reviews found merged by the word rules: different products, different canonical names. */
const APART: [string, Listing, Listing][] = [
  ['256GB vs 512GB', phone('Samsung Galaxy S25 Ultra 256GB', 'Samsung', { model: 'Galaxy S25 Ultra', storage_gb: 256 }), phone('Samsung Galaxy S25 Ultra 512GB', 'Samsung', { model: 'Galaxy S25 Ultra', storage_gb: 512 })],
  ['different brands', L('phones', 'Samsung Galaxy S25 Clear Case', 'Samsung', { brand: 'Samsung', model: 'Galaxy S25 Clear Case' }), L('phones', 'Spigen Galaxy S25 Clear Case', 'Spigen', { brand: 'Spigen', model: 'Galaxy S25 Clear Case' })],
  ['pack of 6 vs 12', L('drinks', 'Heineken Lager 6 x 330ml', 'Heineken', { brand: 'Heineken', line: 'Lager', volume_ml: 330, pack_count: 6 }), L('drinks', 'HEINEKEN LAGER 330ML 12 CANS', 'Heineken', { brand: 'Heineken', line: 'Lager', volume_ml: 330, pack_count: 12 })],
  ['Far Cry new vs pre-owned', L('gaming', 'Far Cry Instincts (Xbox)', null, { line: 'Far Cry Instincts', platform: 'multi' }), L('gaming', 'Far Cry Instincts (Xbox) (Pre-owned)', null, { line: 'Far Cry Instincts', platform: 'multi', condition: 'used' })],
  ['gift card €20 vs €50', L('gaming', 'Steam Gift Card €20', 'Steam', { line: 'Steam Gift Card', face_value: '€20' }), L('gaming', 'Steam Gift Card €50', 'Steam', { line: 'Steam Gift Card', face_value: '€50' })],
  ['iPhone 13 refurbished grade A vs new', phone('Apple iPhone 13 128GB Refurbished Grade A', 'Apple', { model: 'iPhone 13', storage_gb: 128, condition: 'refurbished grade A' }), phone('Apple iPhone 13 128GB', 'Apple', { model: 'iPhone 13', storage_gb: 128 })],
  ['a 256/512GB group vs the 512GB listing', phone('Samsung Galaxy S25 Ultra', 'Samsung', { model: 'Galaxy S25 Ultra' }), phone('Samsung Galaxy S25 Ultra 512GB', 'Samsung', { model: 'Galaxy S25 Ultra', storage_gb: 512 })],
  ['ram 12GB only vs 256GB', phone('Samsung Galaxy S25 Ultra 12GB RAM', 'Samsung', { model: 'Galaxy S25 Ultra', ram_gb: 12 }), phone('Samsung Galaxy S25 Ultra 256GB', 'Samsung', { model: 'Galaxy S25 Ultra', storage_gb: 256 })],
  ['iPhone 15 Plus vs 15', phone('Apple iPhone 15 Plus 128GB Black', 'Apple', { model: 'iPhone 15 Plus', storage_gb: 128 }), phone('Apple iPhone 15 128GB Black', 'Apple', { model: 'iPhone 15', storage_gb: 128 })],
  ['S24 Ultra vs S24', phone('Samsung Galaxy S24 Ultra 256GB', 'Samsung', { model: 'Galaxy S24 Ultra', storage_gb: 256 }), phone('Samsung Galaxy S24 256GB', 'Samsung', { model: 'Galaxy S24', storage_gb: 256 })],
  ['Buds2 Pro vs Buds2', L('tv-audio', 'Samsung Galaxy Buds2 Pro Graphite', 'Samsung', { brand: 'Samsung', model: 'Galaxy Buds2 Pro' }), L('tv-audio', 'Samsung Galaxy Buds2 Graphite', 'Samsung', { brand: 'Samsung', model: 'Galaxy Buds2' })],
  ['Switch OLED vs Lite', L('gaming', 'Nintendo Switch OLED White', 'Nintendo', { line: 'Switch OLED' }), L('gaming', 'Nintendo Switch Lite Turquoise', 'Nintendo', { line: 'Switch Lite' })],
  ['PS5 Slim Digital vs Disc', L('gaming', 'Sony PS5 Slim Digital Edition', 'Sony', { line: 'PS5 Slim', format: 'Digital' }), L('gaming', 'Sony PS5 Slim Disc Edition', 'Sony', { line: 'PS5 Slim', format: 'Disc' })],
  ['LEGO 42115 vs + LEGO Bag', L('toys', 'LEGO Technic 42115 Lamborghini Sian', 'LEGO', { brand: 'LEGO', model: '42115' }), L('toys', 'LEGO Technic 42115 Lamborghini Sian + LEGO Bag', 'LEGO', { brand: 'LEGO', model: '42115', bundle: 'LEGO Bag' })],
  ['PS5 vs PS5 bundle + 2 controllers', L('gaming', 'Sony PS5 Console', 'Sony', { line: 'PS5 Console' }), L('gaming', 'Sony PS5 Console Bundle + 2 Controllers', 'Sony', { line: 'PS5 Console', bundle: '2 Controllers' })],
  ['kids vs adult shoe', L('fashion', 'Nike Air Max 90 Kids', 'Nike', { brand: 'Nike', line: 'Air Max 90', audience: 'kids' }), L('fashion', 'Nike Air Max 90', 'Nike', { brand: 'Nike', line: 'Air Max 90' })],
  ['Cisk 330ml vs pack of 6', L('drinks', 'Cisk Lager 330ml', 'Cisk', { brand: 'Cisk', line: 'Lager', volume_ml: 330 }), L('drinks', 'Cisk Lager 330ml Pack of 6', 'Cisk', { brand: 'Cisk', line: 'Lager', volume_ml: 330, pack_count: 6 })],
  ['Pampers 44 vs 88', L('baby', 'Pampers Baby-Dry Size 4 44 Nappies', 'Pampers', { brand: 'Pampers', line: 'Baby-Dry', pack_count: 44 }), L('baby', 'Pampers Baby-Dry Size 4 88 Nappies', 'Pampers', { brand: 'Pampers', line: 'Baby-Dry', pack_count: 88 })],
  ['Ninja vs Twin Pack', L('appliances', 'Ninja Foodi Power Blender', 'Ninja', { brand: 'Ninja', line: 'Foodi Power Blender' }), L('appliances', 'Ninja Foodi Power Blender Twin Pack', 'Ninja', { brand: 'Ninja', line: 'Foodi Power Blender', pack_count: 2 })],
];

/** Real matches, worded differently by the shops: the same canonical name. */
const TOGETHER: [string, Listing, Listing][] = [
  ['the same phone with different marketing colour words', phone('SAMSUNG Galaxy S23 256GB-Storage 8GB Smartphone, Phantom Black', 'SAMSUNG', { model: 'Galaxy S23', storage_gb: 256, ram_gb: 8 }), phone('Samsung Galaxy S23 5G 256GB Black', 'Samsung', { model: 'Galaxy S23', storage_gb: 256 })],
  ['JW 70cl vs 700ml', L('drinks', 'Johnnie Walker Black Label 70cl', 'Johnnie Walker', { brand: 'Johnnie Walker', line: 'Black Label', volume_ml: 700 }), L('drinks', 'JOHNNIE WALKER BLACK LABEL WHISKY 700ML', 'Johnnie Walker', { brand: 'Johnnie Walker', line: 'Black Label', volume_ml: 700 })],
  ['the same LEGO set', L('toys', 'LEGO Technic 42115 Lamborghini Sian FKP 37', 'LEGO', { brand: 'LEGO', model: '42115', line: 'Technic Lamborghini Sian FKP 37' }), L('toys', 'LEGO 42115 Technic Lamborghini Sián FKP 37', 'Lego', { brand: 'LEGO', model: '42115', line: 'Technic Lamborghini Sián FKP 37' })],
  ['the same TV', L('tv-audio', 'Samsung QE55Q60D 55" QLED 4K Smart TV', 'Samsung', { brand: 'Samsung', model: 'QE55Q60D', screen_in: 55 }), L('tv-audio', 'SAMSUNG 55 Inch Q60D QLED 4K TV QE55Q60D', 'Samsung', { brand: 'Samsung', model: 'QE55Q60D', screen_in: 55 })],
];

describe('canonical names: the pairs of the three reviews', () => {
  for (const [what, a, b] of APART) {
    it(`gives different products different canonical names: ${what}`, () => {
      expect(canon(a)).not.toBe(canon(b));
    });
  }
  for (const [what, a, b] of TOGETHER) {
    it(`gives the same product the same canonical name: ${what}`, () => {
      expect(canon(a)).toBe(canon(b));
    });
  }
});

describe('canonicalName', () => {
  it('writes the category pattern from the fields, case, spacing and units made equal; colour and size never', () => {
    expect(canonicalName('phones', { brand: 'Samsung', model: 'Galaxy S25-Ultra', storage_gb: 1024, colour: ['black'], ram_gb: 12 })).toBe('samsung galaxys25ultra 1tb');
    expect(canonicalName('drinks', { brand: 'Johnnie Walker', line: 'Black Label', volume_ml: 700, age_years: 12 })).toBe('johnniewalker blacklabel 12yearold 700ml');
    // the shared fields follow when present: condition, audience, pack, edition, format, refill, bundle, value
    expect(canonicalName('gaming', { line: 'PS5 Slim', format: 'Digital', condition: 'used', bundle: '2 Controllers', edition: 'Deluxe Edition' })).toBe(
      'ps5slim used deluxeedition digital with2controllers',
    );
    expect(canonicalName('beauty-health', { brand: 'Dior', line: 'Sauvage', concentration: 'Eau de Parfum', volume_ml: 100, refill: 'yes', audience: 'kids' })).toBe(
      'dior sauvage eaudeparfum 100ml kids refill',
    );
    expect(canonicalName('gaming', { line: 'Steam Gift Card', face_value: '20 EUR' })).toBe('steamgiftcard eur20');
    // "model|line": the first present
    expect(canonicalName('laptops', { brand: 'Lenovo', model: 'V15 G5', line: 'V15' })).toBe('lenovo v15g5');
    expect(canonicalName('toys', { brand: 'LEGO', model: '42115', line: 'Technic' })).toBe('lego 42115 technic');
  });

  it('is null without the product line or model, and a pack of 1 is no pack', () => {
    expect(canonicalName('phones', { brand: 'Samsung', storage_gb: 256 })).toBeNull();
    expect(canonicalName('drinks', { brand: 'Cisk', line: 'Lager', pack_count: 1 })).toBe('cisk lager');
  });

  it('refuses colour or size in a pattern, and unknown fields', () => {
    expect(() => parseCanonicalPatterns({ categories: { phones: { canonical: ['brand', 'colour'], brand: {}, colour: {} } } })).toThrow(/colour/);
    expect(() => parseCanonicalPatterns({ categories: { phones: { canonical: ['brand', 'nope'], brand: {} } } })).toThrow(/nope/);
  });
});

describe('checkCanonical: the canonical name keeps what tells the product apart', () => {
  const bad = (l: Listing, what: RegExp) => {
    const r = checkCanonical({ title: l.title, brand: l.brand }, l.category, l.attrs);
    expect(r.ok, l.title).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(what);
  };

  it('rejects fields that lose a model word, number or code of the title', () => {
    bad(phone('Apple iPhone 15 Plus 128GB', 'Apple', { model: 'iPhone 15', storage_gb: 128 }), /plus/);
    bad(phone('Samsung Galaxy S24 Ultra 256GB', 'Samsung', { model: 'Galaxy S24', storage_gb: 256 }), /ultra/);
    bad(L('gaming', 'Sony PS5 Slim Digital Edition', 'Sony', { line: 'PS5 Slim' }), /digital/);
    bad(L('toys', 'LEGO Technic 42115 Lamborghini Sian FKP 37', 'LEGO', { brand: 'LEGO', line: 'Technic Lamborghini Sian FKP' }), /42115|37/);
  });

  it('rejects a storage, volume or pack the title names but the fields leave out', () => {
    bad(phone('Samsung Galaxy S25 Ultra 256GB', 'Samsung', { model: 'Galaxy S25 Ultra' }), /storage_gb/);
    bad(L('drinks', 'Johnnie Walker Black Label 70cl', 'Johnnie Walker', { brand: 'Johnnie Walker', line: 'Black Label' }), /volume_ml/);
    bad(L('drinks', 'Cisk Lager 330ml Pack of 6', 'Cisk', { brand: 'Cisk', line: 'Lager', volume_ml: 330 }), /pack size lost: 6/);
    bad(L('baby', 'Pampers Baby-Dry Size 4 44 Nappies', 'Pampers', { brand: 'Pampers', line: 'Baby-Dry' }), /pack size lost: 44/);
  });

  it('rejects a lost condition, audience, bundle or value', () => {
    bad(L('gaming', 'Far Cry Instincts (Xbox) (Pre-owned)', null, { line: 'Far Cry Instincts' }), /condition lost: used/);
    bad(L('fashion', 'Nike Air Max 90 Kids', 'Nike', { brand: 'Nike', line: 'Air Max 90' }), /kids/);
    bad(L('gaming', 'Sony PS5 Console Bundle + 2 Controllers', 'Sony', { line: 'PS5 Console' }), /bundle/);
    bad(L('gaming', 'Steam Gift Card €20', 'Steam', { line: 'Steam Gift Card' }), /currency value lost: eur20/);
  });

  it('rejects a missing brand, a missing line and a number the shop data does not have', () => {
    bad(phone('Samsung Galaxy S25 Ultra 256GB', 'Samsung', { brand: undefined, model: 'Galaxy S25 Ultra', storage_gb: 256 }), /brand/);
    bad(phone('Samsung Galaxy S25 Ultra 256GB', 'Samsung', { storage_gb: 256 }), /no product line/);
    bad(phone('Samsung Galaxy S25 Ultra', 'Samsung', { model: 'Galaxy S25 Ultra', storage_gb: 256 }), /not in the shop data: 256gb/);
  });

  it('lets colour, size and specs outside the pattern go', () => {
    expect(checkCanonical({ title: 'SAMSUNG Galaxy A17 128GB-Storage 4GB Smartphone, Grey', brand: 'SAMSUNG' }, 'phones', { brand: 'Samsung', model: 'Galaxy A17', storage_gb: 128, ram_gb: 4 }).ok).toBe(true);
    expect(checkCanonical({ title: 'Nike Air Max 90 Size 42 Black', brand: 'Nike' }, 'fashion', { brand: 'Nike', line: 'Air Max 90', sizes: ['42'] }).ok).toBe(true);
    expect(
      checkCanonical({ title: 'LENOVO V15 G5 IRL 15.6" I5/16GB/512SSD/W11P', brand: 'LENOVO' }, 'laptops', {
        brand: 'Lenovo',
        model: 'V15 G5',
        cpu: 'Intel Core i5',
        ram_gb: 16,
        storage_gb: 512,
        screen_in: 15.6,
        os: 'Windows',
      }).ok,
    ).toBe(true);
  });
});
