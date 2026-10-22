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

  it('lets clear numeric shop noise go: percent off and prices', () => {
    const src = { title: 'Nike Air Max 90 -30% OFF now €99,99', brand: 'Nike' };
    expect(checkName(src, name('Nike Air Max 90')).ok).toBe(true);
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
});
