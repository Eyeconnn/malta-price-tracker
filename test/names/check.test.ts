import { describe, expect, it } from 'vitest';
import { checkAttrs, checkBatch, checkName } from '../../src/names/check.js';
import { loadAttributeSchemas } from '../../src/names/schema.js';
import type { Batch } from '../../src/names/prompt.js';
import type { GroupInput } from '../../src/names/select.js';

const schemas = await loadAttributeSchemas();
const laptops = schemas.laptops;

const LENOVO = { title: 'LENOVO THINKBOOK 16 G6 IRL 16" I5/16GB/512SSD/W11P', brand: 'LENOVO' };
const LENOVO_ATTRS = { brand: 'Lenovo', cpu: 'Intel Core i5', os: 'Windows', ram_gb: 16, storage_gb: 512, storage_type: 'SSD', screen_in: 16 };
const LENOVO_NAME = 'Lenovo ThinkBook 16 G6 16" 16GB 512GB';

const name = (display_name: string, attrs: Record<string, unknown> = {}, variant_label: string | null = null) => ({ display_name, variant_label, attrs });
const reasonOf = (r: ReturnType<typeof checkName>) => (r.ok ? '' : r.reason);

describe('checkName: the safety rule', () => {
  it('accepts a clean Lenovo name when every number and code survives and the CPU and OS codes moved into attrs', () => {
    expect(checkName(LENOVO, name(LENOVO_NAME, LENOVO_ATTRS))).toEqual({ ok: true });
  });

  it('rejects the plan example that drops the 16" screen size: "16" of ThinkBook 16 and 16GB of RAM are different numbers', () => {
    const r = checkName(LENOVO, name('Lenovo ThinkBook 16 G6 16GB 512GB', LENOVO_ATTRS));
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toContain('16in');
  });

  it('rejects a dropped RAM size even when another 16 is still in the name', () => {
    const r = checkName({ title: 'Lenovo ThinkBook 16 G6 16GB 512GB', brand: 'Lenovo' }, name('Lenovo ThinkBook 16 G6 512GB'));
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toContain('16gb');
  });

  it('treats I5 and W11P as specs: dropped from the name only when the cpu and os attributes hold them', () => {
    const r = checkName(LENOVO, name(LENOVO_NAME));
    expect(reasonOf(r)).toContain('i5');
    expect(reasonOf(r)).toContain('w11p');
    const cpuOnly = checkName(LENOVO, name(LENOVO_NAME, { cpu: 'Core i5-1335U' }));
    expect(cpuOnly.ok).toBe(false);
    expect(reasonOf(cpuOnly)).not.toContain('i5');
  });

  it('allows the cpu/gpu escape only for CPU and GPU patterns, not for any model code', () => {
    const src = { title: 'Lenovo Legion 5 15ACH6H R7 RTX 3060', brand: 'Lenovo' };
    expect(checkName(src, name('Lenovo Legion 5 15ACH6H', { cpu: 'AMD Ryzen 7 (R7)', gpu: 'RTX 3060' })).ok).toBe(true);
    const r = checkName(src, name('Lenovo Legion 5 R7 RTX 3060', { cpu: '15ACH6H R7' }));
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toContain('15ach6h');
  });

  it('lets letter-only codes such as IRL go', () => {
    expect(checkName(LENOVO, name('Lenovo ThinkBook 16 G6 16" i5 16GB 512GB W11P')).ok).toBe(true);
  });

  it('rejects a name that drops 512 or the model code G6', () => {
    expect(reasonOf(checkName(LENOVO, name('Lenovo ThinkBook 16 G6 16" 16GB', LENOVO_ATTRS)))).toContain('512');
    expect(reasonOf(checkName(LENOVO, name('Lenovo ThinkBook 16 16" 16GB 512GB', LENOVO_ATTRS)))).toContain('g6');
  });

  it('rejects a new number: A5 is not A55', () => {
    const r = checkName({ title: 'Samsung Galaxy A5 2017 Black', brand: 'Samsung' }, name('Samsung Galaxy A55 2017'));
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toMatch(/a55|55/);
  });

  it('rejects a unit swap (16GB to 16TB) and a unit added to a bare number', () => {
    expect(checkName({ title: 'Kingston USB Stick 16GB', brand: 'Kingston' }, name('Kingston USB Stick 16TB')).ok).toBe(false);
    expect(checkName({ title: 'Lenovo IdeaPad 3 8/256', brand: 'Lenovo' }, name('Lenovo IdeaPad 3 8GB 256GB')).ok).toBe(false);
    expect(checkName({ title: 'Lenovo IdeaPad 3 8/256', brand: 'Lenovo' }, name('Lenovo IdeaPad 3 8/256')).ok).toBe(true);
  });

  it('accepts spelling variants of the same unit: 16 GB is 16GB, 15.6" is 15.6 inch, 1.7 Litre is 1.7L', () => {
    expect(checkName({ title: 'HP 250 G9 15,6" 8GB 512SSD', brand: 'HP' }, name('HP 250 G9 15.6 inch 8 GB 512 GB SSD')).ok).toBe(true);
    expect(checkName({ title: 'Philips Kettle 1.7L', brand: 'Philips' }, name('Philips Kettle 1.7 Litre')).ok).toBe(true);
    expect(checkName({ title: 'HP 250 G9 15.6"', brand: 'HP' }, name('HP 250 G9 15"')).ok).toBe(false);
  });

  it('reads thousands separators (1,000W is 1000W, not 1W)', () => {
    expect(checkName({ title: 'Tefal Kettle 1,000W', brand: 'Tefal' }, name('Tefal Kettle 1000W')).ok).toBe(true);
    expect(checkName({ title: 'Tefal Kettle 1,000W', brand: 'Tefal' }, name('Tefal Kettle 1W')).ok).toBe(false);
  });

  it('lets percent off go, but keeps a value with a currency (a gift card, a voucher)', () => {
    const src = { title: 'Nike Air Max 90 -30% OFF now €99,99', brand: 'Nike' };
    expect(checkName(src, name('Nike Air Max 90')).ok).toBe(false);
    expect(checkName(src, name('Nike Air Max 90 €99.99')).ok).toBe(true);
    expect(checkName({ title: 'Nike Air Max 90 20% OFF', brand: 'Nike' }, name('Nike Air Max 90')).ok).toBe(true);
  });

  it('lets barcode-like digit runs (8 or more digits) go', () => {
    expect(checkName({ title: 'Philips Kettle 1.7L (8710103123456)', brand: 'Philips' }, name('Philips Kettle 1.7L')).ok).toBe(true);
  });

  it('rejects invented words: every word of 3+ letters must come from the shop data', () => {
    const src = { title: 'Fjallraven Kanken Backpack Navy', brand: 'Fjallraven' };
    const r = checkName(src, name('Fjallraven Kanken Laptop Backpack'));
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toContain('laptop');
    expect(checkName(src, name('Fjallraven Kanken Backpack', {}, 'Navy')).ok).toBe(true);
    expect(checkName({ title: 'FJÄLLRÄVEN Kånken', brand: null }, name('Fjallraven Kanken')).ok).toBe(true);
  });

  it('takes words and numbers for the variant label from the variant titles, brand and mpn', () => {
    const src = { title: 'Apple iPhone 15', brand: 'Apple', variantTitles: ['128GB Black', '256GB Blue'], mpn: 'MTP03' };
    expect(checkName(src, name('Apple iPhone 15', {}, '128GB, Black')).ok).toBe(true);
    expect(checkName(src, name('Apple iPhone 15 MTP03')).ok).toBe(true);
    expect(checkName(src, name('Apple iPhone 15', {}, '512GB')).ok).toBe(false);
    expect(checkName(src, name('Apple iPhone 15', {}, 'Green')).ok).toBe(false);
  });

  it('rejects URL or domain text in the name or the variant label', () => {
    const src = { title: 'Philips Kettle 1.7L shop.com.mt', brand: 'Philips' };
    expect(checkName(src, name('Philips Kettle 1.7L shop.com.mt')).ok).toBe(false);
    expect(checkName({ title: 'Philips Kettle 1.7L', brand: 'Philips' }, name('Philips Kettle 1.7L', {}, 'www.example')).ok).toBe(false);
    expect(checkName({ title: 'Philips Kettle 1.7L http', brand: 'Philips' }, name('Philips Kettle 1.7L http://x')).ok).toBe(false);
  });

  it('matches the brand on word boundaries (LG is not in "Dell Gaming")', () => {
    const r = checkName({ title: 'Dell Gaming Monitor 27"', brand: 'LG' }, name('Dell Gaming Monitor 27"'));
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toMatch(/brand/);
    expect(checkName({ title: 'LG 27GP850 Monitor', brand: 'LG' }, name('LG 27GP850 Monitor')).ok).toBe(true);
    expect(checkName({ title: 'DR. MARTENS 1460 Boots', brand: 'Dr. Martens' }, name('Dr. Martens 1460 Boots')).ok).toBe(true);
  });

  it('rejects a name that changes the brand, ignores placeholder brands', () => {
    expect(reasonOf(checkName(LENOVO, name('Dell ThinkBook 16 G6 16" 16GB 512GB', LENOVO_ATTRS)))).toMatch(/brand/);
    expect(checkName({ title: 'USB-C Cable 2m', brand: 'Generic' }, name('USB-C Cable 2m')).ok).toBe(true);
  });

  it('rejects HTML, the em dash, and names that are too short or too long', () => {
    const src = { title: 'Philips Kettle 1.7L', brand: 'Philips' };
    expect(checkName(src, name('Philips <b>Kettle</b> 1.7L')).ok).toBe(false);
    expect(checkName(src, name('Philips Kettle \u2014 1.7L')).ok).toBe(false);
    expect(checkName({ title: 'X1', brand: null }, name('X1')).ok).toBe(false);
    expect(checkName(src, name(`Philips Kettle 1.7L ${'kettle '.repeat(20)}`)).ok).toBe(false);
  });

  it('rejects a name that is only the variant label', () => {
    expect(checkName({ title: 'Nike T-Shirt Black', brand: null }, name('Black', {}, 'Black')).ok).toBe(false);
  });

  it('counts tokens moved to the variant label as kept, but not tokens moved to other attributes', () => {
    const src = { title: 'Apple iPhone 15 128GB Black', brand: 'Apple' };
    expect(checkName(src, name('Apple iPhone 15', {}, '128GB, Black')).ok).toBe(true);
    expect(checkName(src, name('Apple iPhone 15', { storage_gb: 128 }, 'Black')).ok).toBe(false);
    expect(checkName({ title: 'Apple iPhone15 128GB', brand: 'Apple' }, name('Apple iPhone 15 128GB')).ok).toBe(true);
  });

  it('keeps single-digit numbers and model words (Pixel 9 Pro)', () => {
    const src = { title: 'Google Pixel 9 Pro 128GB', brand: 'Google' };
    expect(checkName(src, name('Google Pixel 9 Pro 128GB')).ok).toBe(true);
    expect(checkName(src, name('Google Pixel Pro 128GB')).ok).toBe(false);
    expect(checkName(src, name('Google Pixel 9 128GB')).ok).toBe(false);
  });

  it('the recorded haiku answer for an ASUS title is now rejected: it added GB to the bare numbers 8 and 512', () => {
    const src = { title: 'ASUS VIVOBOOK 16X K3605VC 16" I5/8/512/RTX 3050/W11P', brand: null };
    const attrs = { cpu: 'I5', gpu: 'RTX 3050', os: 'Windows' };
    const r = checkName(src, name('ASUS VivoBook 16X K3605VC 16" RTX 3050', attrs, '8GB, 512GB'));
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toContain('8gb');
    expect(checkName(src, name('ASUS VivoBook 16X K3605VC 16" RTX 3050', attrs, '8/512')).ok).toBe(true);
    expect(checkName(src, name('ASUS VivoBook 16X K3605VC 16"', attrs, '8/512')).ok).toBe(true);
  });
});

// Real false rejects of the pilot runs out/names/dry-20261022-222157-haiku.csv, -222802-haiku.csv and -223558-sonnet.csv.
describe('checkName: unreliable brands (shop names, domains, distributors, companies)', () => {
  const ok = (r: ReturnType<typeof checkName>) => expect(r).toEqual({ ok: true });

  it('does not require a shop name, domain or company as the brand', () => {
    ok(checkName({ title: 'Far Cry Instincts (Xbox) (Pre-owned)', brand: 'GameStore.mt', brandStatus: 'unreliable' }, name('Far Cry Instincts (Xbox) (Pre-owned)')));
    ok(checkName({ title: 'LAURA BIAGIOTTI WOMEN LOAFERS', brand: 'OKFASHION.COM.MT', brandStatus: 'unreliable' }, name('Laura Biagiotti Women Loafers')));
    ok(checkName({ title: '15 Denier Matt Sheer Hold-Ups', brand: 'Calzedonia Malta', brandStatus: 'unreliable' }, name('15 Denier Matt Sheer Hold-Ups')));
    ok(checkName({ title: '46834 Frozen 16"', brand: 'Toysmalta', brandStatus: 'unreliable' }, name('46834 Frozen 16"')));
    ok(checkName({ title: 'DGH Large Ruled Notebook Textile Cover Ref :TCC026TCAE7UB003', brand: 'Sterling Holdings', brandStatus: 'unreliable' }, name('DGH Large Ruled Notebook Textile Cover Ref TCC026TCAE7UB003')));
    ok(checkName({ title: 'Childs Farm Sun Cream 50+ SPF Fragrance-Free 200ml', brand: 'M&Z', brandStatus: 'unreliable' }, name('Childs Farm Sun Cream 50+ SPF Fragrance-Free 200ml')));
    ok(checkName({ title: 'Addo Games Unique Boutique My First Makeup Set', brand: 'ADDO PLAY LTD', brandStatus: 'unreliable' }, name('Addo Games Unique Boutique My First Makeup Set')));
    ok(checkName({ title: 'Typhur Sync One 1-Probe Wireless Meat Thermometer', brand: 'iCentre', brandStatus: 'unreliable' }, name('Typhur Sync One 1-Probe Wireless Meat Thermometer')));
    ok(checkName({ title: 'Striped Baby Yoda slippers', brand: '4993716' }, name('Striped Baby Yoda Slippers')));
  });

  it('rejects a name that adds an unreliable brand the title does not have (Tezenis, Carnival, Atmosphera, M&Z)', () => {
    const tez = checkName({ title: 'Canvas Beauty Pochette with Zip', brand: 'Tezenis Malta', brandStatus: 'unreliable' }, name('Tezenis Canvas Beauty Pochette with Zip'));
    expect(tez.ok).toBe(false);
    expect(reasonOf(tez)).toMatch(/tezenis/i);
    expect(checkName({ title: '63708 Little Red Riding Hood', brand: 'Carnival S.R.L.', brandStatus: 'unreliable' }, name('Carnival 63708 Little Red Riding Hood')).ok).toBe(false);
    ok(checkName({ title: '63708 Little Red Riding Hood', brand: 'Carnival S.R.L.', brandStatus: 'unreliable' }, name('63708 Little Red Riding Hood')));
    const tks = { title: 'TKS \u2013 Luca Tea Tree Essential Oil 30ml', brand: 'Atmosphera', brandStatus: 'unreliable' as const };
    expect(checkName(tks, name('Atmosphera Luca Tea Tree Essential Oil 30ml')).ok).toBe(false);
    ok(checkName(tks, name('TKS Luca Tea Tree Essential Oil 30ml')));
    const mz = checkName({ title: 'Childs Farm Nappy Cream 100ml', brand: 'M&Z', brandStatus: 'unreliable' }, name('M&Z Childs Farm Nappy Cream 100ml'));
    expect(mz.ok).toBe(false);
    expect(reasonOf(mz)).toMatch(/M&Z/);
  });

  it('lets a house brand (the shop sells only its own brand) be added without the place word, and not be required', () => {
    const src = { title: '15 Denier Matt Sheer Hold-Ups', brand: 'Calzedonia Malta', brandStatus: 'house' as const };
    ok(checkName(src, name('Calzedonia 15 Denier Matt Sheer Hold-Ups')));
    ok(checkName(src, name('15 Denier Matt Sheer Hold-Ups')));
    expect(reasonOf(checkName(src, name('Calzedonia Malta 15 Denier Matt Sheer Hold-Ups')))).toBe('invented words: malta');
    ok(checkName({ title: 'Securipak 2.0 Laptop Backpack 15.6" - Light Sage', brand: 'Samsonite', brandStatus: 'house' }, name('Samsonite Securipak 2.0 Laptop Backpack 15.6"', {}, 'Light Sage')));
  });

  it('still rejects a real web address, also the shop domain the model adds', () => {
    const r = checkName({ title: 'TV Superstars (PS3) (Pre-owned)', brand: 'GameStore.mt', brandStatus: 'unreliable' }, name('GameStore.mt TV Superstars (PS3) (Pre-owned)'));
    expect(reasonOf(r)).toContain('web address');
  });

  it('requires a reliable brand, and its first word is enough for a brand with a sub-label (Adidas Performance, Superior Electronics, VTECH KIDS)', () => {
    const adidas = { title: 'Train Essentials Train Cotton 3-Stripes Pacer Shorts', brand: 'Adidas Performance', brandStatus: 'reliable' as const };
    ok(checkName(adidas, name('Adidas Train Essentials Train Cotton 3-Stripes Pacer Shorts')));
    expect(reasonOf(checkName(adidas, name('Train Essentials Train Cotton 3-Stripes Pacer Shorts')))).toMatch(/brand Adidas Performance missing/);
    ok(checkName({ title: 'Superior  Tower Slim \u2013 Support to stack washing machine and dryer \u2013 SUPSLW002', brand: 'Superior Electronics', brandStatus: 'reliable' }, name('Superior Tower Slim Support to Stack Washing Machine and Dryer SUPSLW002')));
    ok(checkName({ title: 'Pop-A-Block Truck', brand: 'VTECH KIDS', brandStatus: 'reliable' }, name('VTech Pop-A-Block Truck')));
    ok(checkName({ title: 'Fee Brothers - Old Fashion Aromatic Bitters 15cl', brand: 'Fee Bros', brandStatus: 'reliable' }, name('Fee Brothers Old Fashion Aromatic Bitters 15cl')));
  });

  it('accepts the initials of a brand that the title uses (M&S for Marks & Spencer)', () => {
    ok(checkName({ title: 'M&S Food Microwave Chow Mein Noodle Box 300g', brand: 'Marks & Spencer', brandStatus: 'reliable' }, name('M&S Food Microwave Chow Mein Noodle Box 300g')));
  });

  it('without a status, judges the brand by its own text only (company words, web address, numbers)', () => {
    ok(checkName({ title: 'Mummy Bear and Babies Figurine REF: 1009290', brand: 'Sterling Holdings' }, name('Mummy Bear and Babies Figurine 1009290')));
    expect(checkName({ title: 'Dell Gaming Monitor 27"', brand: 'LG' }, name('Dell Gaming Monitor 27"')).ok).toBe(false);
  });
});

describe('checkName: spelling variants, joined and split words, symbols', () => {
  const ok = (r: ReturnType<typeof checkName>) => expect(r).toEqual({ ok: true });

  it('counts UK and US spellings as the same word', () => {
    ok(checkName({ title: 'LEXIBOOK Multicolor Magic Magnetic Nintendo Super Mario Drawing Board', brand: 'Lexibook' }, name('Lexibook Magic Magnetic Nintendo Super Mario Drawing Board', {}, 'Multicolour')));
    ok(checkName({ title: 'APPLE WATCH SE 3 GPS 44MM MIDNIGHT ALUMINIUM CASE WITH MIDNIGHT SPORT BAND - S/M', brand: 'Apple' }, name('Apple Watch SE 3 GPS 44mm Midnight Aluminum Case with Midnight Sport Band', {}, 'S/M')));
    ok(checkName({ title: 'Apple iPad Mini (7th Gen) Cellular 8.3 inch 256GB Space Grey', brand: 'Apple' }, name('Apple iPad Mini (7th Gen) Cellular 8.3" 256GB', {}, 'Space Gray')));
    ok(checkName({ title: 'Philips Kettle 1.7 Litre Centre Base', brand: 'Philips' }, name('Philips Kettle 1.7 Liter Center Base')));
    ok(checkName({ title: 'T\u2019nB Jack 3.5mm Coiled Cable 1.8 metre', brand: "T'nB" }, name('T\u2019nB Jack 3.5mm Coiled Cable 1.8m')));
  });

  it('accepts words joined or split differently from the title (HOTPOINTARISTON, Wi-Fi)', () => {
    ok(checkName({ title: 'HOTPOINTARISTON HAFC8-TIA22W 335Ltr Free-Standing Fridge-Freezer', brand: 'HOTPOINTARISTON' }, name('Hotpoint Ariston HAFC8-TIA22W 335Ltr Free-Standing Fridge-Freezer')));
    ok(checkName({ title: 'TP-Link 3-Piece Set WiFi Powerline Kit 300Mbps \u2013 TLWPA4220X3', brand: 'TP-Link' }, name('TP-Link 3-Piece Set Wi-Fi Powerline Kit 300Mbps TLWPA4220X3')));
    ok(checkName({ title: 'Reolink 4K 8MP Wi-Fi 6 IP Camera with Colour Night Vision \u2013 W330', brand: 'Reolink' }, name('Reolink 4K 8MP WiFi 6 IP Camera with Color Night Vision W330')));
    // joining the title's words is fine; a word the data does not have is still invented
    expect(checkName({ title: 'Severin Air Fryer 7L', brand: 'Severin' }, name('Severin Airfryer 7L')).ok).toBe(true);
    expect(reasonOf(checkName({ title: 'Severin Air Fryer 7L', brand: 'Severin' }, name('Severin Airfryer Pro 7L')))).toBe('invented words: pro');
  });

  it('treats & as and, + as plus and w/ as with', () => {
    ok(checkName({ title: 'Trevi IP68 Smart Fitness Watch for iOS & Android Black \u2013 TFIT320BK', brand: 'Trevi' }, name('Trevi IP68 Smart Fitness Watch for iOS and Android TFIT320BK', {}, 'Black')));
    ok(checkName({ title: 'JBL Tune 500 Wired Headphones + Mic White \u2013 T500WHT', brand: 'JBL' }, name('JBL Tune 500 Wired Headphones Plus Mic T500WHT', {}, 'White')));
    // a + the data does not have is not added (review I2)
    expect(checkName({ title: 'Samsung Galaxy S24 Plus 256GB', brand: 'Samsung' }, name('Samsung Galaxy S24+ 256GB')).ok).toBe(false);
    ok(checkName({ title: 'Philips SHC5200M2 Black Wireless Headphones w/ Transmitter', brand: 'Philips' }, name('Philips SHC5200M2 Wireless Headphones with Transmitter', {}, 'Black')));
    ok(checkName({ title: 'Xiaomi Watch S5 46mm Ceramic Blue w/Leather Strap Smartwatch', brand: 'Xiaomi' }, name('Xiaomi Watch S5 46mm Ceramic Blue with Leather Strap Smartwatch')));
  });

  it('reads trademark signs as nothing, not as TM (DualSense\u2122, UltraGear\u2122)', () => {
    ok(checkName({ title: 'Sony DualSense\u2122 Wireless Controller', brand: 'Sony' }, name('Sony DualSense Wireless Controller')));
    ok(checkName({ title: 'LG 32\u2033 UltraGear\u2122 QHD 180Hz Monitor', brand: 'LG' }, name('LG 32" UltraGear QHD 180Hz Monitor')));
    ok(checkName({ title: 'CRY BABY\u00ae CUSTOM BADASS\u2122 DUAL-INDUCTOR EDITION WAH', brand: null }, name('Cry Baby Custom Badass Dual-Inductor Edition Wah')));
  });

  it('reads 40\u00d730 cm as 40x30cm and keeps a percent the title has (40% ABV), but not a new one', () => {
    ok(checkName({ title: 'EDM BBQ Mat 40\u00d730 cm', brand: 'EDM' }, name('EDM BBQ Mat 40x30cm')));
    ok(checkName({ title: "Ballantine's 10 Years Old 40% 1Ltr", brand: "Ballantine's" }, name("Ballantine's 10 Years Old 40% 1L")));
    expect(checkName({ title: "Ballantine's 10 Years Old 40% 1Ltr", brand: "Ballantine's" }, name("Ballantine's 10 Years Old 43% 1L")).ok).toBe(false);
  });

  it('accepts a dotted brand or product spelling copied from the title (b.box, Go.Up, Glas.tR), never a shop domain', () => {
    ok(checkName({ title: 'b.box spoon twin pack - blue/green', brand: 'b.box' }, name('b.box Spoon Twin Pack', {}, 'Blue/Green')));
    ok(checkName({ title: 'Globber Helmet Go.Up XXS/XS Pastel Blue', brand: 'Globber' }, name('Globber Helmet Go.Up', {}, 'XXS/XS, Pastel Blue')));
    ok(checkName({ title: 'Spigen Glas.tR Ez Fit Screen Protector iPhone Air Clear 2-pk', brand: 'Spigen' }, name('Spigen Glas.tR Ez Fit Screen Protector iPhone Air 2-pk', {}, 'Clear')));
    expect(reasonOf(checkName({ title: 'b.box spoon twin pack', brand: 'b.box' }, name('b.box Spoon vanillamummy.com')))).toContain('web address');
    expect(reasonOf(checkName({ title: 'Philips Kettle 1.7L shop.com.mt', brand: 'Philips' }, name('Philips Kettle 1.7L shop.com.mt')))).toContain('web address');
  });
});

// Rejects of the rerun out/names/dry-20261023-073704-haiku.csv (490 of 500 accepted).
describe('checkName: rerun rejects of 2026-10-23', () => {
  const ok = (r: ReturnType<typeof checkName>) => expect(r).toEqual({ ok: true });

  it('treats +, & and and as the same word, and lets the variant label join values with and', () => {
    ok(checkName({ title: 'Kids Beauty Vanity Table + Stool White', brand: 'Small Foot', brandStatus: 'reliable' }, name('Small Foot Kids Beauty Vanity Table and Stool', {}, 'White')));
    // & reads as and, not as plus (review I2)
    ok(checkName({ title: 'Philips SHC5200M2 Headphones & Transmitter', brand: 'Philips' }, name('Philips SHC5200M2 Headphones and Transmitter')));
    expect(checkName({ title: 'Philips SHC5200M2 Headphones & Transmitter', brand: 'Philips' }, name('Philips SHC5200M2 Headphones Plus Transmitter')).ok).toBe(false);
    // iPad Pro M4: "and" came from the label joining the two sizes of the variants
    const ipad = { title: 'iPad Pro M4', brand: 'Apple', brandStatus: 'reliable' as const, variantTitles: ['Storage: 256GB, Size: 11\u2033', 'Storage: 256GB, Size: 13\u2033'] };
    ok(checkName(ipad, name('Apple iPad Pro M4', {}, '256GB, 11" and 13"')));
    expect(checkName(ipad, name('Apple iPad Pro M4 and Pencil', {}, '256GB')).ok).toBe(false);
  });

  it('still rejects a lost set number or product code (LEGO 77247, 40922, LeapFrog 19348, JBL T500WHT)', () => {
    expect(reasonOf(checkName({ title: 'LEGO SPEED CHAMPIONS KICK SAUBER F1 TEAM C44 RACE CAR 77247', brand: null }, name('LEGO Speed Champions Kick Sauber F1 Team C44 Race Car')))).toContain('77247');
    expect(reasonOf(checkName({ title: 'Lego 40922 Lilo and Stitch Angel', brand: null }, name('LEGO Lilo and Stitch Angel')))).toContain('40922');
    expect(reasonOf(checkName({ title: "19348   LEAPFROG Number Lovin' Oven - Pink", brand: 'Leapfrog' }, name("LeapFrog Number Lovin' Oven", {}, 'Pink')))).toContain('19348');
    expect(reasonOf(checkName({ title: 'JBL Tune 500 Wired Headphones + Mic White \u2013 T500WHT', brand: 'JBL' }, name('JBL Tune 500 Wired Headphones + Mic', {}, 'White')))).toContain('t500wht');
    ok(checkName({ title: 'LEGO SPEED CHAMPIONS KICK SAUBER F1 TEAM C44 RACE CAR 77247', brand: null }, name('LEGO Speed Champions 77247 Kick Sauber F1 Team C44 Race Car')));
  });

  it('keeps the maker the title starts with: no swap for the brand field (Therabody TheraCup, brand Theragun)', () => {
    const src = { title: 'Therabody TheraCup (Single)', brand: 'Theragun', brandStatus: 'reliable' as const, titleBrand: 'Therabody' };
    const swap = checkName(src, name('Theragun TheraCup'));
    expect(swap.ok).toBe(false);
    expect(reasonOf(swap)).toContain('title brand Therabody dropped');
    // the title's maker wins, so the brand field's value is not required then
    ok(checkName(src, name('Therabody TheraCup', {}, 'Single')));
    ok(checkName({ title: 'Paw Patrol My First Laptop', brand: 'Colorbaby', brandStatus: 'unreliable', titleBrand: 'Paw Patrol', variantTitles: ['Chase', 'Marshall'] }, name('Paw Patrol My First Laptop', {}, 'Chase, Marshall')));
  });
});

// Review of 1769c46 and 21b4a04: the reviewer's pairs.
describe('checkName: review fixes', () => {
  const ok = (r: ReturnType<typeof checkName>) => expect(r).toEqual({ ok: true });
  const bad = (r: ReturnType<typeof checkName>) => expect(r.ok).toBe(false);

  it('C1: a lost model word is not kept by a longer word that merely starts or ends with it', () => {
    bad(checkName({ title: 'Apple iPhone 15 Pro Screen Protector', brand: 'Apple' }, name('Apple iPhone 15 Screen Protector')));
    bad(checkName({ title: 'Apple iPhone SE 2022 Silicone Case', brand: 'Apple' }, name('Apple iPhone 2022 Silicone Case')));
    bad(checkName({ title: 'Galaxy S23 FE Safe Charger', brand: null }, name('Galaxy S23 Safe Charger')));
    bad(checkName({ title: 'MacBook Air 13 with AirTag cover', brand: null }, name('MacBook 13 with AirTag cover')));
    // still fine: the title's own words written together (Air Fryer as Airfryer)
    ok(checkName({ title: 'Severin Air Fryer 7L', brand: 'Severin' }, name('Severin Airfryer 7L')));
  });

  it('I2: plus only from a + in the title or variants, and from & or a spaced +; no new + glued to a word', () => {
    ok(checkName({ title: 'Samsung Galaxy S24+ 256GB', brand: 'Samsung' }, name('Samsung Galaxy S24 Plus 256GB')));
    ok(checkName({ title: 'Samsung Galaxy S24+ 256GB', brand: 'Samsung' }, name('Samsung Galaxy S24+ 256GB')));
    bad(checkName({ title: 'Samsung Galaxy S24 Plus 256GB', brand: 'Samsung' }, name('Samsung Galaxy S24+ 256GB')));
    ok(checkName({ title: 'Samsung Galaxy S24 Plus 256GB', brand: 'Samsung' }, name('Samsung Galaxy S24 Plus 256GB')));
    ok(checkName({ title: 'Kids Beauty Vanity Table + Stool White', brand: null }, name('Kids Beauty Vanity Table and Stool', {}, 'White')));
    // the mpn is no source of and or plus
    bad(checkName({ title: 'Wired Headphones Mic', brand: null, mpn: 'HP+MIC-01' }, name('Wired Headphones Plus Mic')));
    // SPF 50+ keeps its +
    ok(checkName({ title: 'Childs Farm Sun Cream 50+ SPF Fragrance-Free 200ml', brand: 'Childs Farm' }, name('Childs Farm Sun Cream 50+ SPF Fragrance-Free 200ml')));
  });

  it('I2: a percent is required unless it is percent-off noise (Glenfiddich 40%)', () => {
    const src = { title: 'Glenfiddich 12 Year Old Single Malt 40% 70cl', brand: 'Glenfiddich' };
    ok(checkName(src, name('Glenfiddich 12 Year Old Single Malt 40% 70cl')));
    bad(checkName(src, name('Glenfiddich 12 Year Old Single Malt 70cl')));
    ok(checkName({ title: 'Nike Air Max 90 -30% now', brand: 'Nike' }, name('Nike Air Max 90')));
    ok(checkName({ title: 'Nike Air Max 90 20% off', brand: 'Nike' }, name('Nike Air Max 90')));
  });

  it('I3: the first word of a brand is enough only when the title lacks the full brand', () => {
    bad(checkName({ title: 'Black & Decker BXGR1001E Mini Grill 1000W', brand: 'Black & Decker' }, name('Black BXGR1001E Mini Grill 1000W')));
    ok(checkName({ title: 'Black & Decker BXGR1001E Mini Grill 1000W', brand: 'Black & Decker' }, name('Black & Decker BXGR1001E Mini Grill 1000W')));
    bad(checkName({ title: 'Red Bull Energy Drink 250ml', brand: 'Red Bull' }, name('Red Energy Drink 250ml')));
    bad(checkName({ title: 'Fisher-Price Laugh & Learn Smart Stages Chair', brand: 'Fisher-Price' }, name('Fisher Laugh & Learn Smart Stages Chair')));
    ok(checkName({ title: 'Train Essentials Train Cotton 3-Stripes Pacer Shorts', brand: 'Adidas Performance', brandStatus: 'reliable' }, name('Adidas Train Essentials Train Cotton 3-Stripes Pacer Shorts')));
  });

  it('I4: an unreliable brand whose name the title has must be kept (Sony Group)', () => {
    const src = { title: 'Sony WH-1000XM5 Wireless Headphones', brand: 'Sony Group', brandStatus: 'unreliable' as const, brandNote: 'company or place name' };
    bad(checkName(src, name('WH-1000XM5 Wireless Headphones')));
    ok(checkName(src, name('Sony WH-1000XM5 Wireless Headphones')));
    // a one-letter label left after the label word (T of "T - Accessories") is no maker name
    ok(checkName({ title: 'T - Vacuum Pump Wine Stoppers with 4 Bottle Stoppers Sealer x 1 box', brand: 'T - Accessories', brandStatus: 'unreliable', brandNote: 'company or place name' }, name('Vacuum Pump Wine Stoppers with 4 Bottle Stoppers Sealer', {}, 'x 1 box')));
    // a shop name in the title stays shop noise
    ok(checkName({ title: 'Toysmalta 46834 Frozen 16"', brand: 'Toysmalta', brandStatus: 'unreliable', brandNote: 'shop name' }, name('46834 Frozen 16"')));
  });
});

describe('checkName: a + glued to a title word survives (re-review H1)', () => {
  it('rejects a name that drops it and accepts "plus" after the same word', () => {
    const r = (title: string, n: string) => checkName({ title, brand: null }, name(n));
    expect(r('Samsung Galaxy S23+ 256GB', 'Samsung Galaxy S23 256GB').ok).toBe(false);
    expect(r('Apple iPhone 15+', 'Apple iPhone 15').ok).toBe(false);
    expect(r('Galaxy Tab S9 FE+', 'Galaxy Tab S9 FE').ok).toBe(false);
    expect(r('Childs Farm Sun Cream SPF 50+', 'Childs Farm Sun Cream SPF 50').ok).toBe(false);
    expect(r('Galaxy S23+', 'Galaxy S23 Plus')).toEqual({ ok: true });
    expect(r('Galaxy S23+', 'Galaxy S23+')).toEqual({ ok: true });
  });
});

describe('checkAttrs', () => {
  it('drops keys outside the category schema and records them', () => {
    const r = checkAttrs({ ram_gb: 16, flavour: 'mint' }, laptops);
    expect(r.attrs).toEqual({ ram_gb: 16 });
    expect(r.dropped).toEqual(['flavour (not in schema)']);
  });

  it('maps enum values case-insensitively and drops values outside the list', () => {
    const r = checkAttrs({ storage_type: 'ssd', os: 'BeOS' }, laptops);
    expect(r.attrs).toEqual({ storage_type: 'SSD' });
    expect(r.dropped).toEqual(['os (not an allowed value)']);
  });

  it('drops numbers out of bounds or not finite, accepts plain numeric strings', () => {
    const r = checkAttrs({ ram_gb: 4096, screen_in: '15.6', storage_gb: Number.NaN }, laptops);
    expect(r.attrs).toEqual({ screen_in: 15.6 });
    expect(r.dropped.sort()).toEqual(['ram_gb (number out of range)', 'storage_gb (not a number)']);
  });

  it('turns a single value of a multi attribute into a list and checks every value', () => {
    expect(checkAttrs({ colour: 'Black' }, laptops).attrs).toEqual({ colour: ['black'] });
    expect(checkAttrs({ colour: ['Black', 'plaid', 'black'] }, laptops).attrs).toEqual({ colour: ['black'] });
  });

  it('drops text with HTML or a web address and skips nulls silently', () => {
    const r = checkAttrs({ cpu: '<b>i5</b>', gpu: null, model: 'see www.shop.mt' }, laptops);
    expect(r.attrs).toEqual({});
    expect(r.dropped).toEqual(['cpu (bad text)', 'model (bad text)']);
  });
});

function group(over: Partial<GroupInput>): GroupInput {
  return {
    shopId: 1, shopSlug: 'shop', groupKey: 'g', title: 't', brand: null, category: 'laptops', categoryPath: null,
    gtin: null, mpn: null, variantTitles: [], storedHash: null, ...over,
  };
}

describe('checkBatch', () => {
  const batch: Batch = {
    category: 'laptops',
    items: [
      { key: '1', group: group({ groupKey: 'a', title: LENOVO.title, brand: LENOVO.brand }) },
      { key: '2', group: group({ groupKey: 'b', title: 'Acer Aspire 5 A515', variantTitles: ['Silver'] }) },
    ],
  };

  it('rejects a missing item and ignores answers with unknown keys', () => {
    const out = { items: [{ key: '1', display_name: LENOVO_NAME, variant_label: null, attrs: LENOVO_ATTRS }, { key: '99', display_name: 'x', variant_label: null, attrs: {} }] };
    const r = checkBatch(batch, out, laptops);
    expect(r.results.map((x) => [x.item.key, x.status])).toEqual([['1', 'ok'], ['2', 'rejected']]);
    expect(r.results[1].reason).toBe('missing from answer');
    expect(r.unknownKeys).toEqual(['99']);
    expect(r.results[0].displayName).toBe(LENOVO_NAME);
  });

  it('stores no name and no attrs for a rejected item but keeps the proposal for the report; uses the variant titles', () => {
    const out = { items: [
      { key: '1', display_name: 'Lenovo ThinkBook', variant_label: null, attrs: LENOVO_ATTRS },
      { key: '2', display_name: 'Acer Aspire 5 A515', variant_label: 'Silver', attrs: { bogus: 1 } },
    ] };
    const r = checkBatch(batch, out, laptops);
    expect(r.results[0].status).toBe('rejected');
    expect(r.results[0].displayName).toBeNull();
    expect(r.results[0].attrs).toEqual({});
    expect(r.results[0].proposedName).toBe('Lenovo ThinkBook');
    expect(r.results[1].status).toBe('ok');
    expect(r.results[1].dropped).toEqual(['bogus (not in schema)']);
  });

  it('uses the group brand status and drops an unreliable brand from attrs; keeps the proposed variant label of a rejected item', () => {
    const fashion = schemas.fashion;
    const b: Batch = {
      category: 'fashion',
      items: [
        { key: '1', group: group({ category: 'fashion', title: '15 Denier Matt Sheer Hold-Ups', brand: 'Calzedonia Malta', brandStatus: 'unreliable' }) },
        { key: '2', group: group({ category: 'fashion', groupKey: 'b', title: 'Canvas Beauty Pochette with Zip', brand: 'Tezenis Malta', brandStatus: 'unreliable' }) },
      ],
    };
    const out = { items: [
      { key: '1', display_name: '15 Denier Matt Sheer Hold-Ups', variant_label: null, attrs: { brand: 'Calzedonia Malta' } },
      { key: '2', display_name: 'Canvas Beauty Pochette with Zip', variant_label: 'tezenismalta.com', attrs: {} },
    ] };
    const r = checkBatch(b, out, fashion);
    expect(r.results[0].status).toBe('ok');
    expect(r.results[0].attrs).toEqual({});
    expect(r.results[0].dropped).toEqual(['brand (unreliable brand, not the maker)']);
    expect(r.results[1].status).toBe('rejected');
    expect(r.results[1].proposedLabel).toBe('tezenismalta.com');
  });

  it('passes the title maker of the group to the name check', () => {
    const b: Batch = { category: 'beauty-health', items: [{ key: '1', group: group({ category: 'beauty-health', title: 'Therabody TheraCup (Single)', brand: 'Theragun', brandStatus: 'reliable', titleBrand: 'Therabody' }) }] };
    const r = checkBatch(b, { items: [{ key: '1', display_name: 'Theragun TheraCup', variant_label: 'Single', attrs: {} }] }, schemas['beauty-health']);
    expect(r.results[0].reason).toBe('title brand Therabody dropped');
  });
});

describe('checkName: condition and currency values stay in the clean name (review C1)', () => {
  const bad = (r: ReturnType<typeof checkName>, what: RegExp) => {
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(what);
  };

  it('rejects a name that drops the condition of a used, refurbished or open-box item', () => {
    bad(checkName({ title: 'Far Cry Instincts (Xbox) (Pre-owned)', brand: null }, name('Far Cry Instincts (Xbox)')), /condition lost: used/);
    bad(checkName({ title: 'Apple iPhone 13 128GB Refurbished Grade A', brand: 'Apple' }, name('Apple iPhone 13 Refurbished', {}, '128GB')), /condition lost: grade a/);
    bad(checkName({ title: 'Sony WH-1000XM5 Open Box', brand: 'Sony' }, name('Sony WH-1000XM5')), /condition lost: open box/);
    bad(checkName({ title: 'Fender Strat B-Stock', brand: 'Fender' }, name('Fender Strat')), /condition lost: b-stock/);
    bad(checkName({ title: 'Dyson V15 ex-display', brand: 'Dyson' }, name('Dyson V15')), /condition lost: ex-display/);
    bad(checkName({ title: 'Kindle Paperwhite (Renewed)', brand: 'Amazon' }, name('Amazon Kindle Paperwhite')), /condition lost: refurbished/);
    bad(checkName({ title: 'PS5 Demo Unit', brand: null }, name('PS5 Unit')), /condition lost: demo/);
    // in the variant label is not enough: the condition is part of the product, not an option
    bad(checkName({ title: 'Far Cry Instincts (Xbox) (Pre-owned)', brand: null }, name('Far Cry Instincts (Xbox)', {}, 'Pre-owned')), /condition lost/);
  });

  it('accepts the condition in any spelling', () => {
    expect(checkName({ title: 'Far Cry Instincts (Xbox) (Pre-owned)', brand: null }, name('Far Cry Instincts (Xbox) Preowned')).ok).toBe(true);
    expect(checkName({ title: 'Apple iPhone 13 128GB Refurb Grade A', brand: 'Apple' }, name('Apple iPhone 13 128GB Refurb Grade A')).ok).toBe(true);
  });

  it('rejects a name that drops or changes a value with a currency', () => {
    bad(checkName({ title: 'Steam Gift Card €20', brand: 'Steam' }, name('Steam Gift Card')), /currency value lost: eur20/);
    bad(checkName({ title: 'Steam Gift Card 20 EUR', brand: 'Steam' }, name('Steam Gift Card $20')), /currency value lost: eur20/);
    bad(checkName({ title: 'Amazon voucher £50', brand: 'Amazon' }, name('Amazon Voucher')), /currency value lost: gbp50/);
    expect(checkName({ title: 'Steam Gift Card 20 EUR', brand: 'Steam' }, name('Steam Gift Card €20')).ok).toBe(true);
    expect(checkName({ title: 'PSN Card $10', brand: null }, name('PSN Card $10')).ok).toBe(true);
  });
});

describe('checkName: model words, pack sizes and distinguishing words stay in the clean name (re-review)', () => {
  const bad = (r: ReturnType<typeof checkName>, what: RegExp) => {
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(what);
  };
  const good = (r: ReturnType<typeof checkName>) => expect(r).toEqual({ ok: true });

  it('keeps model words in the name itself, never only in the variant label', () => {
    bad(checkName({ title: 'Apple iPhone 15 Plus 128GB Black', brand: 'Apple' }, name('Apple iPhone 15', {}, 'Plus, 128GB, Black')), /lost tokens: plus/);
    good(checkName({ title: 'Apple iPhone 15 Plus 128GB Black', brand: 'Apple' }, name('Apple iPhone 15 Plus', {}, '128GB, Black')));
    bad(checkName({ title: 'Samsung Galaxy S24 Ultra 256GB', brand: 'Samsung' }, name('Samsung Galaxy S24', {}, 'Ultra, 256GB')), /lost tokens: ultra/);
    good(checkName({ title: 'Samsung Galaxy S24 Ultra 256GB', brand: 'Samsung' }, name('Samsung Galaxy S24 Ultra', {}, '256GB')));
    bad(checkName({ title: 'Samsung Galaxy Buds2 Pro Graphite', brand: 'Samsung' }, name('Samsung Galaxy Buds2', {}, 'Pro, Graphite')), /lost tokens: pro/);
    bad(checkName({ title: 'Nintendo Switch OLED Console White', brand: 'Nintendo' }, name('Nintendo Switch Console', {}, 'OLED, White')), /lost tokens: oled/);
    good(checkName({ title: 'Nintendo Switch OLED Console White', brand: 'Nintendo' }, name('Nintendo Switch OLED Console', {}, 'White')));
    bad(checkName({ title: 'Sony PS5 Slim Digital Edition Console', brand: 'Sony' }, name('Sony PS5 Slim Edition Console', {}, 'Digital')), /lost tokens: digital/);
    bad(checkName({ title: 'Sony PS5 Slim Digital Edition Console', brand: 'Sony' }, name('Sony PS5 Digital Edition Console')), /lost tokens: slim/);
    good(checkName({ title: 'Sony PS5 Slim Digital Edition Console', brand: 'Sony' }, name('Sony PS5 Slim Digital Edition Console')));
    // a + glued to a model must stay in the name too
    bad(checkName({ title: 'Samsung Galaxy S23+ 256GB', brand: 'Samsung' }, name('Samsung Galaxy S23', {}, '+, 256GB')), /S23\+|s23\+/i);
  });

  it('keeps edition and format words (Twin, Bundle, Deluxe, Kids) in the name', () => {
    bad(checkName({ title: 'Ninja Foodi Power Blender Twin Pack', brand: 'Ninja' }, name('Ninja Foodi Power Blender')), /lost tokens: twin/);
    good(checkName({ title: 'Ninja Foodi Power Blender Twin Pack', brand: 'Ninja' }, name('Ninja Foodi Power Blender Twin Pack')));
    bad(checkName({ title: 'Hogwarts Legacy Deluxe Edition (PS5)', brand: null }, name('Hogwarts Legacy (PS5)', {}, 'Deluxe Edition')), /lost tokens: deluxe/);
    bad(checkName({ title: 'Nike Air Max 90 Kids Trainers', brand: 'Nike' }, name('Nike Air Max 90 Trainers')), /lost tokens: kids/);
    // a size may still go to the variant label when the attributes list it
    good(checkName({ title: 'Nike Club Fleece Hoodie XL', brand: 'Nike' }, name('Nike Club Fleece Hoodie', { sizes: ['XL'] }, 'XL')));
  });

  it('keeps pack and count numbers in the name or as the pack count', () => {
    bad(checkName({ title: 'Cisk Lager 330ml Pack of 6', brand: 'Cisk' }, name('Cisk Lager 330ml', {}, 'Pack of 6')), /pack size lost: 6/);
    good(checkName({ title: 'Cisk Lager 330ml Pack of 6', brand: 'Cisk' }, name('Cisk Lager 330ml Pack of 6')));
    good(checkName({ title: 'Cisk Lager 330ml Pack of 6', brand: 'Cisk' }, name('Cisk Lager 330ml', { pack_count: 6 }, 'Pack of 6')));
    bad(checkName({ title: 'Cisk Lager 6x330ml', brand: 'Cisk' }, name('Cisk Lager 330ml', {}, '6x')), /pack size lost: 6/);
    bad(checkName({ title: 'Pampers Baby-Dry Size 4 44 Nappies', brand: 'Pampers' }, name('Pampers Baby-Dry Size 4 Nappies', {}, '44')), /pack size lost: 44/);
    good(checkName({ title: 'Pampers Baby-Dry Size 4 44 Nappies', brand: 'Pampers' }, name('Pampers Baby-Dry Size 4 Nappies', { pack_count: 44 }, '44')));
    good(checkName({ title: 'Pampers Baby-Dry Size 4 44 Nappies', brand: 'Pampers' }, name('Pampers Baby-Dry Size 4 44 Nappies')));
  });

  it('keeps more condition words: damaged, like new, excellent condition, preloved, second hand', () => {
    bad(checkName({ title: 'Dyson V11 Vacuum - Damaged item', brand: 'Dyson' }, name('Dyson V11 Vacuum')), /condition lost: damaged/);
    good(checkName({ title: 'Dyson V11 Vacuum - Damaged item', brand: 'Dyson' }, name('Dyson V11 Vacuum Damaged Item')));
    bad(checkName({ title: 'iPad Air Like New', brand: 'Apple' }, name('Apple iPad Air')), /condition lost: like new/);
    bad(checkName({ title: 'Gucci Bag (Excellent Condition)', brand: 'Gucci' }, name('Gucci Bag')), /condition lost: excellent condition/);
    bad(checkName({ title: 'Preloved Barbour Jacket', brand: 'Barbour' }, name('Barbour Jacket')), /condition lost: used/);
    bad(checkName({ title: 'Second Hand Bike', brand: null }, name('Bike')), /condition lost: used/);
  });
});
