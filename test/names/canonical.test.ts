// Canonical names (design "Update 23 Oct"): built by code from the identity fields Claude returns, never from its
// free text, and checked against the shop title the other way round: every title word must be in the canonical
// name unless it is a colour, size, filler, price or outside-the-pattern word. The answers are fixtures (no Claude call).
import { describe, expect, it } from 'vitest';
import { canonicalName, checkCanonical, parseCanonicalPatterns } from '../../src/names/canonical.js';
import { guardOf } from '../../src/site/matching.js';

type Listing = { title: string; brand: string | null; category: string; attrs: Record<string, unknown>; variantTitles?: string[] };
const L = (category: string, title: string, brand: string | null, attrs: Record<string, unknown>, variantTitles?: string[]): Listing => ({ title, brand, category, attrs, variantTitles });
const phone = (title: string, brand: string | null, attrs: Record<string, unknown>, variantTitles?: string[]) => L('phones', title, brand, { brand: brand ?? 'Apple', ...attrs }, variantTitles);

const check = (l: Listing) => checkCanonical({ title: l.title, brand: l.brand, variantTitles: l.variantTitles }, l.category, l.attrs);

/** The canonical name a listing gets: the checker must accept it. */
function canon(l: Listing): string {
  const r = check(l);
  if (!r.ok) throw new Error(`${l.title}: ${r.reason}`);
  return r.canonical;
}

/** Whether two listings would be one product: both accepted, the same canonical name and the same title guard. */
function sameProduct(a: Listing, b: Listing): boolean {
  const x = check(a);
  const y = check(b);
  return x.ok && y.ok && x.canonical === y.canonical && a.category === b.category && guardOf(a.title, a.category) === guardOf(b.title, b.category);
}

/** The pairs of the three earlier reviews, with complete fields: both accepted, different canonical names. */
const APART: [string, Listing, Listing][] = [
  ['256GB vs 512GB', phone('Samsung Galaxy S25 Ultra 256GB', 'Samsung', { model: 'Galaxy S25 Ultra', storage_gb: 256 }), phone('Samsung Galaxy S25 Ultra 512GB', 'Samsung', { model: 'Galaxy S25 Ultra', storage_gb: 512 })],
  ['different brands', phone('Samsung Galaxy S25 Clear Case', 'Samsung', { model: 'Galaxy S25 Clear Case' }), phone('Spigen Galaxy S25 Clear Case', 'Spigen', { model: 'Galaxy S25 Clear Case' })],
  ['pack of 6 vs 12', L('drinks', 'Heineken Lager 6 x 330ml', 'Heineken', { brand: 'Heineken', line: 'Lager', volume_ml: 330, pack_count: 6 }), L('drinks', 'HEINEKEN LAGER 330ML 12 CANS', 'Heineken', { brand: 'Heineken', line: 'Lager', volume_ml: 330, pack_count: 12 })],
  ['Far Cry new vs pre-owned', L('gaming', 'Ubisoft Far Cry Instincts (Xbox)', 'Ubisoft', { brand: 'Ubisoft', line: 'Far Cry Instincts', platform: 'Xbox One' }), L('gaming', 'Ubisoft Far Cry Instincts (Xbox) (Pre-owned)', 'Ubisoft', { brand: 'Ubisoft', line: 'Far Cry Instincts', platform: 'Xbox One', condition: 'used' })],
  ['gift card €20 vs €50', L('gaming', 'Steam Gift Card €20', 'Steam', { brand: 'Steam', line: 'Gift Card', face_value: '€20' }), L('gaming', 'Steam Gift Card €50', 'Steam', { brand: 'Steam', line: 'Gift Card', face_value: '€50' })],
  ['iPhone 13 refurbished grade A vs new', phone('Apple iPhone 13 128GB Refurbished Grade A', 'Apple', { model: 'iPhone 13', storage_gb: 128, condition: 'refurbished grade A' }), phone('Apple iPhone 13 128GB', 'Apple', { model: 'iPhone 13', storage_gb: 128 })],
  ['a 256/512GB group vs the 512GB listing', phone('Samsung Galaxy S25 Ultra', 'Samsung', { model: 'Galaxy S25 Ultra' }), phone('Samsung Galaxy S25 Ultra 512GB', 'Samsung', { model: 'Galaxy S25 Ultra', storage_gb: 512 })],
  ['ram 12GB only vs 256GB', phone('Samsung Galaxy S25 Ultra 12GB RAM', 'Samsung', { model: 'Galaxy S25 Ultra', ram_gb: 12 }), phone('Samsung Galaxy S25 Ultra 256GB', 'Samsung', { model: 'Galaxy S25 Ultra', storage_gb: 256 })],
  ['iPhone 15 Plus vs 15', phone('Apple iPhone 15 Plus 128GB Black', 'Apple', { model: 'iPhone 15 Plus', storage_gb: 128 }), phone('Apple iPhone 15 128GB Black', 'Apple', { model: 'iPhone 15', storage_gb: 128 })],
  ['S24 Ultra vs S24', phone('Samsung Galaxy S24 Ultra 256GB', 'Samsung', { model: 'Galaxy S24 Ultra', storage_gb: 256 }), phone('Samsung Galaxy S24 256GB', 'Samsung', { model: 'Galaxy S24', storage_gb: 256 })],
  ['Buds2 Pro vs Buds2', L('tv-audio', 'Samsung Galaxy Buds2 Pro Graphite', 'Samsung', { brand: 'Samsung', model: 'Galaxy Buds2 Pro' }), L('tv-audio', 'Samsung Galaxy Buds2 Graphite', 'Samsung', { brand: 'Samsung', model: 'Galaxy Buds2' })],
  ['Switch OLED vs Lite', L('gaming', 'Nintendo Switch OLED White', 'Nintendo', { brand: 'Nintendo', line: 'Switch OLED' }), L('gaming', 'Nintendo Switch Lite Turquoise', 'Nintendo', { brand: 'Nintendo', line: 'Switch Lite' })],
  ['PS5 Slim Digital vs Disc', L('gaming', 'Sony PS5 Slim Digital Edition', 'Sony', { brand: 'Sony', line: 'PS5 Slim', format: 'Digital' }), L('gaming', 'Sony PS5 Slim Disc Edition', 'Sony', { brand: 'Sony', line: 'PS5 Slim', format: 'Disc' })],
  ['LEGO 42115 vs + LEGO Bag', L('toys', 'LEGO Technic 42115 Lamborghini Sian', 'LEGO', { brand: 'LEGO', model: '42115' }), L('toys', 'LEGO Technic 42115 Lamborghini Sian + LEGO Bag', 'LEGO', { brand: 'LEGO', model: '42115', bundle: 'LEGO Bag' })],
  ['PS5 vs PS5 bundle + 2 controllers', L('gaming', 'Sony PS5 Console', 'Sony', { brand: 'Sony', line: 'PS5' }), L('gaming', 'Sony PS5 Console Bundle + 2 Controllers', 'Sony', { brand: 'Sony', line: 'PS5', bundle: '2 Controllers' })],
  ['kids vs adult shoe', L('fashion', 'Nike Air Max 90 Kids', 'Nike', { brand: 'Nike', line: 'Air Max 90', audience: 'kids' }), L('fashion', 'Nike Air Max 90', 'Nike', { brand: 'Nike', line: 'Air Max 90' })],
  ['Cisk 330ml vs pack of 6', L('drinks', 'Cisk Lager 330ml', 'Cisk', { brand: 'Cisk', line: 'Lager', volume_ml: 330 }), L('drinks', 'Cisk Lager 330ml Pack of 6', 'Cisk', { brand: 'Cisk', line: 'Lager', volume_ml: 330, pack_count: 6 })],
  ['Pampers 44 vs 88', L('baby', 'Pampers Baby-Dry Size 4 44 Nappies', 'Pampers', { brand: 'Pampers', line: 'Baby-Dry', nappy_size: 'Size 4', pack_count: 44 }), L('baby', 'Pampers Baby-Dry Size 4 88 Nappies', 'Pampers', { brand: 'Pampers', line: 'Baby-Dry', nappy_size: 'Size 4', pack_count: 88 })],
  ['Ninja vs Twin Pack', L('appliances', 'Ninja Foodi Power Blender', 'Ninja', { brand: 'Ninja', line: 'Foodi Power Blender' }), L('appliances', 'Ninja Foodi Power Blender Twin Pack', 'Ninja', { brand: 'Ninja', line: 'Foodi Power Blender', pack_count: 2 })],
];

/** Review of 013b134: a field left empty must never give the canonical name of another product. */
const EMPTY_FIELD: [string, Listing, Listing][] = [
  ['EDT vs EDP, concentration left empty', L('beauty-health', 'Dior Sauvage Eau de Toilette 100ml', 'Dior', { brand: 'Dior', line: 'Sauvage', volume_ml: 100 }), L('beauty-health', 'Dior Sauvage Eau de Parfum 100ml', 'Dior', { brand: 'Dior', line: 'Sauvage', volume_ml: 100 })],
  ['mens vs womens, gender left empty', L('fashion', 'Nike Air Max 90 Mens', 'Nike', { brand: 'Nike', line: 'Air Max 90' }), L('fashion', 'Nike Air Max 90 Womens', 'Nike', { brand: 'Nike', line: 'Air Max 90' })],
  ['PS5 vs PS4, platform left empty', L('gaming', 'EA FIFA 23 PS5', 'EA', { brand: 'EA', line: 'FIFA 23' }), L('gaming', 'EA FIFA 23 PS4', 'EA', { brand: 'EA', line: 'FIFA 23' })],
  ['hardback vs paperback', L('other', 'Penguin Dune Hardback', 'Penguin', { brand: 'Penguin', line: 'Dune' }), L('other', 'Penguin Dune Paperback', 'Penguin', { brand: 'Penguin', line: 'Dune' })],
  ['deluxe edition, edition left empty', L('gaming', 'Bandai Elden Ring Deluxe Edition PS5', 'Bandai', { brand: 'Bandai', line: 'Elden Ring', platform: 'PS5' }), L('gaming', 'Bandai Elden Ring PS5', 'Bandai', { brand: 'Bandai', line: 'Elden Ring', platform: 'PS5' })],
  ['S24 FE vs S24, FE left out of the model', phone('Samsung Galaxy S24 FE 128GB', 'Samsung', { model: 'Galaxy S24', storage_gb: 128 }), phone('Samsung Galaxy S24 128GB', 'Samsung', { model: 'Galaxy S24', storage_gb: 128 })],
  ['nappies size 4 vs 5, size left empty', L('baby', 'Pampers Baby-Dry Size 4 44 Nappies', 'Pampers', { brand: 'Pampers', line: 'Baby-Dry', pack_count: 44 }), L('baby', 'Pampers Baby-Dry Size 5 44 Nappies', 'Pampers', { brand: 'Pampers', line: 'Baby-Dry', pack_count: 44 })],
  ['monthly box vs plain pack', L('baby', 'Pampers Baby-Dry Size 4 Monthly Box 174 Nappies', 'Pampers', { brand: 'Pampers', line: 'Baby-Dry', nappy_size: 'Size 4', pack_count: 174 }), L('baby', 'Pampers Baby-Dry Size 4 174 Nappies', 'Pampers', { brand: 'Pampers', line: 'Baby-Dry', nappy_size: 'Size 4', pack_count: 174 })],
  ['DualSense Edge vs DualSense', L('gaming', 'Sony DualSense Edge Controller PS5', 'Sony', { brand: 'Sony', line: 'DualSense Controller', platform: 'PS5' }), L('gaming', 'Sony DualSense Controller PS5', 'Sony', { brand: 'Sony', line: 'DualSense Controller', platform: 'PS5' })],
  ['4G vs 5G, network left empty', phone('Samsung Galaxy A55 4G 128GB', 'Samsung', { model: 'Galaxy A55', storage_gb: 128 }), phone('Samsung Galaxy A55 5G 128GB', 'Samsung', { model: 'Galaxy A55', storage_gb: 128 })],
  ['6GB vs 8GB RAM, RAM left empty', phone('Samsung Galaxy A35 128GB 6GB', 'Samsung', { model: 'Galaxy A35', storage_gb: 128 }), phone('Samsung Galaxy A35 128GB 8GB', 'Samsung', { model: 'Galaxy A35', storage_gb: 128 })],
  ['a 128/256GB group vs the 256GB listing', phone('Samsung Galaxy S25 256GB', 'Samsung', { model: 'Galaxy S25', storage_gb: 256 }, ['128GB', '256GB']), phone('Samsung Galaxy S25 256GB', 'Samsung', { model: 'Galaxy S25', storage_gb: 256 })],
  ['Verona 2-Mesh vs 2-Solid (one shop)', phone('GARETTELECTRONICS Verona 2-Mesh Smartwatch, Gold', 'Garettelectronics', { model: 'Verona 2' }), phone('GARETTELECTRONICS Verona 2-Solid Smartwatch, Gold', 'Garettelectronics', { model: 'Verona 2' })],
  ['Watch6 Classic vs Watch6', phone('Samsung Galaxy Watch6 Classic', 'Samsung', { model: 'Galaxy Watch6' }), phone('Samsung Galaxy Watch6', 'Samsung', { model: 'Galaxy Watch6' })],
  ['dual zone air fryer vs air fryer', L('appliances', 'Ninja Foodi Dual Zone Air Fryer AF300', 'Ninja', { brand: 'Ninja', model: 'AF300' }), L('appliances', 'Ninja Air Fryer AF300', 'Ninja', { brand: 'Ninja', model: 'AF300' })],
  ['Kindle Kids vs Kindle', phone('Amazon Kindle Paperwhite Kids', 'Amazon', { model: 'Kindle Paperwhite' }), phone('Amazon Kindle Paperwhite', 'Amazon', { model: 'Kindle Paperwhite' })],
  ['a game without a brand', L('gaming', 'Hogwarts Legacy PS5', null, { line: 'Hogwarts Legacy', platform: 'PS5' }), L('gaming', 'Hogwarts Legacy PS5', null, { line: 'Hogwarts Legacy', platform: 'PS5' })],
  ['with case vs without', L('tv-audio', 'Sony WH-1000XM5 with Case', 'Sony', { brand: 'Sony', model: 'WH-1000XM5' }), L('tv-audio', 'Sony WH-1000XM5', 'Sony', { brand: 'Sony', model: 'WH-1000XM5' })],
  ['Barbie & Ken vs Barbie', L('toys', 'Mattel Barbie & Ken', 'Mattel', { brand: 'Mattel', line: 'Barbie' }), L('toys', 'Mattel Barbie', 'Mattel', { brand: 'Mattel', line: 'Barbie' })],
  ['multipack vs single can', L('drinks', 'Coca-Cola Original 330ml Multipack', 'Coca-Cola', { brand: 'Coca-Cola', line: 'Original', volume_ml: 330 }), L('drinks', 'Coca-Cola Original 330ml', 'Coca-Cola', { brand: 'Coca-Cola', line: 'Original', volume_ml: 330 })],
  ['FC 25 Gold Edition vs FC 25 (gold is a colour word)', L('gaming', 'EA FC 25 Gold Edition PS5', 'EA', { brand: 'EA', line: 'FC 25', platform: 'PS5' }), L('gaming', 'EA FC 25 PS5', 'EA', { brand: 'EA', line: 'FC 25', platform: 'PS5' })],
  ['ultimate edition, edition left empty', L('gaming', 'Ubisoft Assassins Creed Shadows Ultimate Edition PS5', 'Ubisoft', { brand: 'Ubisoft', line: 'Assassins Creed Shadows', platform: 'PS5' }), L('gaming', 'Ubisoft Assassins Creed Shadows PS5', 'Ubisoft', { brand: 'Ubisoft', line: 'Assassins Creed Shadows', platform: 'PS5' })],
  ['signature vs plain', L('tv-audio', 'Sennheiser Momentum 4 Signature', 'Sennheiser', { brand: 'Sennheiser', model: 'Momentum 4' }), L('tv-audio', 'Sennheiser Momentum 4', 'Sennheiser', { brand: 'Sennheiser', model: 'Momentum 4' })],
  ['limited edition controller', L('gaming', 'Microsoft Xbox Wireless Controller Limited Edition', 'Microsoft', { brand: 'Microsoft', line: 'Xbox Wireless Controller' }), L('gaming', 'Microsoft Xbox Wireless Controller', 'Microsoft', { brand: 'Microsoft', line: 'Xbox Wireless Controller' })],
];

/** Real matches, worded differently by the shops: the same canonical name and guard. */
const TOGETHER: [string, Listing, Listing][] = [
  ['the same phone with marketing colour words', phone('SAMSUNG Galaxy S23 5G 256GB 8GB Smartphone, Phantom Black', 'SAMSUNG', { brand: 'Samsung', model: 'Galaxy S23', storage_gb: 256, ram_gb: 8, network: '5G' }), phone('Samsung Galaxy S23 5G 256GB 8GB Black', 'Samsung', { model: 'Galaxy S23', storage_gb: 256, ram_gb: 8, network: '5G' })],
  ['JW 70cl vs 700ml', L('drinks', 'Johnnie Walker Black Label 70cl', 'Johnnie Walker', { brand: 'Johnnie Walker', line: 'Black Label', volume_ml: 700 }), L('drinks', 'JOHNNIE WALKER BLACK LABEL WHISKY 700ML', 'Johnnie Walker', { brand: 'Johnnie Walker', line: 'Black Label', volume_ml: 700, style: 'Blended Scotch Whisky' })],
  ['the same LEGO set by its set number', L('toys', 'LEGO Technic 42115 Lamborghini Sian FKP 37', 'LEGO', { brand: 'LEGO', model: '42115', line: 'Technic Lamborghini Sian FKP 37' }), L('toys', 'LEGO 42115 Building Set', 'Lego', { brand: 'LEGO', model: '42115' })],
  ['the same TV with a region suffix', L('tv-audio', 'Samsung QE55Q60DAUXXU 55" QLED 4K Smart TV', 'Samsung', { brand: 'Samsung', model: 'QE55Q60DAUXXU', screen_in: 55, panel: 'QLED' }), L('tv-audio', 'SAMSUNG 55 Inch QLED TV QE55Q60D', 'Samsung', { brand: 'Samsung', model: 'QE55Q60D', screen_in: 55, panel: 'QLED' })],
  ['2nd Gen is II', L('tv-audio', 'Apple AirPods Pro (2nd Gen)', 'Apple', { brand: 'Apple', model: 'AirPods Pro 2nd Gen' }), L('tv-audio', 'Apple AirPods Pro II', 'Apple', { brand: 'Apple', model: 'AirPods Pro II' })],
  ['Intel Core i5-1335U is i5-1335U', L('laptops', 'Lenovo IdeaPad Slim 3 15.6" Intel Core i5-1335U 16GB 512GB', 'Lenovo', { brand: 'Lenovo', model: 'IdeaPad Slim 3', cpu: 'Intel Core i5-1335U', ram_gb: 16, storage_gb: 512, screen_in: 15.6 }), L('laptops', 'LENOVO IDEAPAD SLIM 3 15.6" I5-1335U 16GB 512GB SSD', 'LENOVO', { brand: 'Lenovo', model: 'IdeaPad Slim 3', cpu: 'i5-1335U', ram_gb: 16, storage_gb: 512, screen_in: 15.6 })],
  ['NE 3850 is NE3850', L('appliances', 'Philips Steam Iron NE 3850', 'Philips', { brand: 'Philips', model: 'NE3850', appliance_type: 'Steam Iron' }), L('appliances', 'Philips NE3850 Steam Iron', 'Philips', { brand: 'Philips', model: 'NE3850', appliance_type: 'Steam Iron' })],
  ['PlayStation 5 is PS5', L('gaming', 'Sony PlayStation 5 Slim Console', 'Sony', { brand: 'Sony', line: 'PS5 Slim' }), L('gaming', 'Sony PS5 Slim Console', 'Sony', { brand: 'Sony', line: 'PlayStation 5 Slim' })],
  ['an iPhone is an Apple', phone('iPhone 15 128GB', null, { brand: 'Apple', model: 'iPhone 15', storage_gb: 128 }), phone('Apple iPhone 15 128GB Black', 'Apple', { model: 'iPhone 15', storage_gb: 128 })],
  ['a maker part number in the title', phone('Samsung Galaxy S24 SM-S921B 128GB 8GB 5G', 'Samsung', { model: 'Galaxy S24', storage_gb: 128, ram_gb: 8, network: '5G' }), phone('Samsung Galaxy S24 5G 128GB 8GB', 'Samsung', { model: 'Galaxy S24', storage_gb: 128, ram_gb: 8, network: '5G' })],
  ['Pampers by its size and count', L('baby', 'Pampers Baby-Dry Size 4 44 Nappies', 'Pampers', { brand: 'Pampers', line: 'Baby-Dry', nappy_size: 'Size 4', pack_count: 44 }), L('baby', 'PAMPERS BABY DRY NAPPIES SIZE 4 X44', 'Pampers', { brand: 'Pampers', line: 'Baby Dry', nappy_size: 'Size 4', pack_count: 44 })],
];

describe('canonical names: the pairs of the three earlier reviews', () => {
  for (const [what, a, b] of APART) {
    it(`gives different products different canonical names: ${what}`, () => {
      expect(canon(a)).not.toBe(canon(b));
    });
  }
});

describe('canonical names: a field left empty never gives another product (review of 013b134)', () => {
  for (const [what, a, b] of EMPTY_FIELD) {
    it(`keeps apart: ${what}`, () => {
      expect(sameProduct(a, b)).toBe(false);
    });
  }
});

describe('canonical names: true matches', () => {
  for (const [what, a, b] of TOGETHER) {
    it(`is one product: ${what}`, () => {
      expect(canon(a)).toBe(canon(b));
      expect(sameProduct(a, b)).toBe(true);
    });
  }
});

describe('canonicalName', () => {
  it('writes the category pattern from the fields, case, spacing and units made equal; colour and size never', () => {
    expect(canonicalName('phones', { brand: 'Samsung', model: 'Galaxy S25-Ultra', storage_gb: 1024, colour: ['black'], ram_gb: 12, network: '5G' })).toBe('samsung galaxys25ultra 1tb 12gbram 5g');
    expect(canonicalName('drinks', { brand: 'Johnnie Walker', line: 'Black Label', volume_ml: 700, age_years: 12 })).toBe('johnniewalker blacklabel 12yearold 700ml');
    expect(canonicalName('gaming', { brand: 'Sony', line: 'PS5 Slim', format: 'Digital', condition: 'used', bundle: '2 Controllers', edition: 'Deluxe Edition' })).toBe(
      'sony ps5slim used deluxeedition digital with2controllers',
    );
    expect(canonicalName('beauty-health', { brand: 'Dior', line: 'Sauvage', concentration: 'EDP', volume_ml: 100, refill: 'yes', audience: 'kids' })).toBe('dior sauvage edp 100ml kids refill');
    expect(canonicalName('gaming', { brand: 'Steam', line: 'Gift Card', face_value: '20 EUR' })).toBe('steam giftcard eur20');
    // "model|line": the first present; CPU vendor words and TV region suffixes are dropped
    expect(canonicalName('toys', { brand: 'LEGO', model: '42115', line: 'Technic' })).toBe('lego 42115');
    expect(canonicalName('laptops', { brand: 'Acer', model: 'Nitro V 15', cpu: 'AMD Ryzen 7 7735HS' })).toBe('acer nitrov15 r7 7735hs');
    expect(canonicalName('tv-audio', { brand: 'LG', model: 'OLED55C46LA', screen_in: 55 })).toBe('lg oled55c46 55in');
  });

  it('is null without the brand the pattern has or the product line, and a pack of 1 is no pack', () => {
    expect(canonicalName('phones', { brand: 'Samsung', storage_gb: 256 })).toBeNull();
    expect(canonicalName('gaming', { line: 'Hogwarts Legacy', platform: 'PS5' })).toBeNull();
    expect(canonicalName('drinks', { brand: 'Cisk', line: 'Lager', pack_count: 1 })).toBe('cisk lager');
  });

  it('refuses colour or size in a pattern, and unknown fields', () => {
    expect(() => parseCanonicalPatterns({ categories: { phones: { canonical: ['brand', 'colour'], brand: {}, colour: {} } } })).toThrow(/colour/);
    expect(() => parseCanonicalPatterns({ categories: { phones: { canonical: ['brand', 'nope'], brand: {} } } })).toThrow(/nope/);
  });
});

describe('checkCanonical: every title word is in the canonical name, or excused', () => {
  const bad = (l: Listing, what: RegExp) => {
    const r = check(l);
    expect(r.ok, l.title).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(what);
  };
  const good = (l: Listing) => {
    const r = check(l);
    expect(r.ok ? 'ok' : r.reason, l.title).toBe('ok');
    return r.ok ? r.canonical : '';
  };

  it('excuses the type words shops add (Office Notebook, In-Ear Earphones, Portable Speaker), Copilot+ and the GPU memory (stored names on Neon)', () => {
    const lap = (title: string, brand: string, attrs: Record<string, unknown>) => L('laptops', title, brand, attrs);
    good(lap('LENOVO V15 G5 IRL 15.6” Intel Core i5 Office Notebook, 16GB, 512GB SSD', 'LENOVO', { brand: 'Lenovo', model: 'V15 G5 IRL', cpu: 'Intel Core i5', ram_gb: 16, storage_gb: 512, screen_in: 15.6 }));
    expect(good(lap('ASUS TUF Gaming A16 16” AMD Ryzen 7 Gaming Notebook, 16GB, RTX5060-8GB, 1TB SSD', 'ASUS', { brand: 'ASUS', model: 'TUF Gaming A16', cpu: 'AMD Ryzen 7', gpu: 'RTX 5060', ram_gb: 16, storage_gb: 1024, screen_in: 16 }))).toBe('asus tufgaminga16 r7 16gbram 1tb 16in rtx5060');
    good(lap('ACER Acer Nitro V 16 AI, Copilot + PC 16” AMD Ryzen AI 9 Gaming Notebook, 32GB, RTX-5070-8GB, 1TB SSD', 'ACER', { brand: 'Acer', model: 'Nitro V 16 AI', cpu: 'AMD Ryzen AI 9', gpu: 'RTX 5070', ram_gb: 32, storage_gb: 1024, screen_in: 16 }));
    good(lap('ASUS Vivobook X1607 Copilot+ 16” Intel Core Ultra 5 Office Notebook, 16GB, 512GB SSD', 'ASUS', { brand: 'ASUS', model: 'Vivobook X1607', cpu: 'Intel Core Ultra 5', ram_gb: 16, storage_gb: 512, screen_in: 16 }));
    good(lap('LENOVO IdeaPad Slim 5 Copilot + 16” AMD Ryzen AI 7 Office Notebook, 16GB, 512GB SSD', 'LENOVO', { brand: 'Lenovo', model: 'IdeaPad Slim 5', cpu: 'AMD Ryzen AI 7', ram_gb: 16, storage_gb: 512, screen_in: 16 }));
    good(L('tv-audio', 'JBL Tune Flex 2 In-Ear Wireless Earphones, Black', 'JBL', { brand: 'JBL', model: 'Tune Flex 2' }));
    good(L('tv-audio', 'KAKUSIGA KSC-695 Over-Ear Wireless Headphones, Black', 'KAKUSIGA', { brand: 'Kakusiga', model: 'KSC-695' }));
    good(L('tv-audio', 'JBL Tune 525BT On-Ear Wireless Headphones, White', 'JBL', { brand: 'JBL', model: 'Tune 525BT' }));
    good(L('tv-audio', 'JBL GO Essential 2 Bluetooth Portable Speaker, Red', 'JBL', { brand: 'JBL', model: 'GO Essential 2' }));
    // a GPU memory the gpu field does not have is no other word, but wired is (wireless is filler)
    bad(lap('MSI Cyborg 15 B2RWFKG 15.6” Intel Core 7 Gaming Notebook, 16GB, RTX-5060, 1TB SSD 8GB', 'MSI', { brand: 'MSI', model: 'Cyborg 15 B2RWFKG', cpu: 'Intel Core 7', gpu: 'RTX 5060', ram_gb: 16, storage_gb: 1024, screen_in: 15.6 }), /8gb/);
    bad(L('tv-audio', 'AUDEEO Radiant LX On-Ear Wired Headphones, Blue', 'AUDEEO', { brand: 'Audeeo', model: 'Radiant LX' }), /wired/);
  });

  it('rejects fields that lose a word, number or code of the title', () => {
    bad(phone('Apple iPhone 15 Plus 128GB', 'Apple', { model: 'iPhone 15', storage_gb: 128 }), /plus/);
    bad(L('gaming', 'Sony PS5 Slim Digital Edition', 'Sony', { brand: 'Sony', line: 'PS5 Slim' }), /digital/);
    bad(L('beauty-health', 'Dior Sauvage Eau de Toilette 100ml', 'Dior', { brand: 'Dior', line: 'Sauvage', volume_ml: 100 }), /edt/);
    bad(phone('Samsung Galaxy S25 Ultra 256GB', 'Samsung', { model: 'Galaxy S25 Ultra' }), /256gb/);
    bad(phone('Samsung Galaxy A55 5G 128GB', 'Samsung', { model: 'Galaxy A55', storage_gb: 128 }), /5g/);
  });

  it('rejects a lost condition, pack, bundle or value, and a number the shop data does not have', () => {
    bad(L('gaming', 'Ubisoft Far Cry Instincts (Xbox) (Pre-owned)', 'Ubisoft', { brand: 'Ubisoft', line: 'Far Cry Instincts', platform: 'Xbox One' }), /condition lost: used/);
    bad(L('drinks', 'Cisk Lager 330ml Pack of 6', 'Cisk', { brand: 'Cisk', line: 'Lager', volume_ml: 330 }), /pack size lost: 6/);
    bad(L('gaming', 'Sony PS5 Console Bundle + 2 Controllers', 'Sony', { brand: 'Sony', line: 'PS5' }), /bundle/);
    bad(L('gaming', 'Steam Gift Card €20', 'Steam', { brand: 'Steam', line: 'Gift Card' }), /currency value lost: eur20/);
    bad(phone('Samsung Galaxy S25 Ultra', 'Samsung', { model: 'Galaxy S25 Ultra', storage_gb: 256 }), /not in the shop data: 256gb/);
  });

  it('rejects a missing brand when the pattern has one, a missing line, and variants with two storages', () => {
    bad(phone('Samsung Galaxy S25 Ultra 256GB', 'Samsung', { brand: undefined, model: 'Galaxy S25 Ultra', storage_gb: 256 }), /no brand/);
    bad(L('gaming', 'Hogwarts Legacy PS5', null, { line: 'Hogwarts Legacy', platform: 'PS5' }), /no brand/);
    bad(phone('Samsung Galaxy S25 Ultra 256GB', 'Samsung', { storage_gb: 256 }), /no product line/);
    bad(phone('Samsung Galaxy S25 256GB', 'Samsung', { model: 'Galaxy S25', storage_gb: 256 }, ['128GB', '256GB']), /variants differ in storage_gb/);
  });

  it('excuses colour, size, filler, price words and fields outside the pattern', () => {
    good(phone('SAMSUNG Galaxy A17 128GB-Storage 4GB Smartphone, Grey', 'SAMSUNG', { brand: 'Samsung', model: 'Galaxy A17', storage_gb: 128, ram_gb: 4 }));
    good(L('fashion', 'Nike Air Max 90 Size 42 Black', 'Nike', { brand: 'Nike', line: 'Air Max 90', sizes: ['42'] }));
    good(L('laptops', 'LENOVO V15 G5 IRL 15.6" I5/16GB/512SSD/W11P', 'LENOVO', { brand: 'Lenovo', model: 'V15 G5 IRL', cpu: 'Intel Core i5', ram_gb: 16, storage_gb: 512, screen_in: 15.6, os: 'Windows' }));
    good(phone('Apple iPhone 15 128GB Black - Black Friday Sale -10%', 'Apple', { model: 'iPhone 15', storage_gb: 128 }));
  });

  it('does not reject real titles for their wording (review of 013b134, I4)', () => {
    // "2 In-Ear" is no 2 inch screen
    expect(good(L('tv-audio', 'JBL Tune Buds 2 In-Ear Wireless Earbuds', 'JBL', { brand: 'JBL', model: 'Tune Buds 2 In-Ear', device_type: 'earbuds' }))).not.toMatch(/2in\b/);
    // Copilot+ PC is a label, not a bundle
    good(L('laptops', 'Acer Swift Go 14 Copilot+ PC 14" Intel Core Ultra 7 16GB 1TB', 'Acer', { brand: 'Acer', model: 'Swift Go 14', cpu: 'Intel Core Ultra 7', ram_gb: 16, storage_gb: 1024, screen_in: 14 }));
    // channel numbers are kept as tokens
    expect(good(L('tv-audio', 'LENCO SBW-801BK 2.1 Channel Bluetooth Soundbar', 'LENCO', { brand: 'Lenco', model: 'SBW-801BK', channels: '2.1', device_type: 'soundbar' }))).toContain('2.1');
    // a code inside a longer code
    good(L('tv-audio', 'LG OLED55C46LA 55" C4 OLED 4K Smart TV', 'LG', { brand: 'LG', model: 'OLED55C46LA', screen_in: 55, panel: 'OLED' }));
    // a set number with its building set words
    good(L('toys', 'LEGO Creator 31058 Mighty Dinosaurs Building Set', 'LEGO', { brand: 'LEGO', model: '31058' }));
  });
});
