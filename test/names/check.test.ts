import { describe, expect, it } from 'vitest';
import { checkAttrs, checkBatch, checkName } from '../../src/names/check.js';
import { loadAttributeSchemas } from '../../src/names/schema.js';
import type { Batch } from '../../src/names/prompt.js';
import type { GroupInput } from '../../src/names/select.js';

const schemas = await loadAttributeSchemas();
const laptops = schemas.laptops;

const LENOVO = { title: 'LENOVO THINKBOOK 16 G6 IRL 16" I5/16GB/512SSD/W11P', brand: 'LENOVO' };
const LENOVO_ATTRS = { brand: 'Lenovo', cpu: 'Intel Core i5', os: 'Windows', ram_gb: 16, storage_gb: 512, storage_type: 'SSD', screen_in: 16 };

describe('checkName: the safety rule', () => {
  it('accepts a clean Lenovo name when every number and model token survives and the specs moved into attrs', () => {
    const r = checkName(LENOVO, { display_name: 'Lenovo ThinkBook 16 G6 16GB 512GB', variant_label: null, attrs: LENOVO_ATTRS });
    expect(r).toEqual({ ok: true });
  });

  it('treats I5 and W11P as specs: dropped from the name only when the cpu and os attributes hold them', () => {
    const r = checkName(LENOVO, { display_name: 'Lenovo ThinkBook 16 G6 16GB 512GB', variant_label: null, attrs: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('i5');
      expect(r.reason).toContain('w11p');
    }
    const cpuOnly = checkName(LENOVO, { display_name: 'Lenovo ThinkBook 16 G6 16GB 512GB', variant_label: null, attrs: { cpu: 'Core i5-1335U' } });
    expect(cpuOnly.ok).toBe(false);
    if (!cpuOnly.ok) expect(cpuOnly.reason).not.toContain('i5');
  });

  it('lets letter-only codes such as IRL go (they cannot be told apart from shop noise)', () => {
    expect(checkName(LENOVO, { display_name: 'Lenovo ThinkBook 16 G6 i5 16GB 512GB W11P', variant_label: null, attrs: {} }).ok).toBe(true);
  });

  it('rejects a name that drops 512', () => {
    const r = checkName(LENOVO, { display_name: 'Lenovo ThinkBook 16 G6 16GB', variant_label: null, attrs: LENOVO_ATTRS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('512');
  });

  it('rejects a name that drops the model code G6', () => {
    const r = checkName(LENOVO, { display_name: 'Lenovo ThinkBook 16 16GB 512GB', variant_label: null, attrs: LENOVO_ATTRS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('g6');
  });

  it('rejects a name that changes the brand', () => {
    const r = checkName(LENOVO, { display_name: 'Dell ThinkBook 16 G6 16GB 512GB', variant_label: null, attrs: LENOVO_ATTRS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/brand/);
  });

  it('ignores placeholder brands such as Generic', () => {
    expect(checkName({ title: 'USB-C Cable 2m', brand: 'Generic' }, { display_name: 'USB-C Cable 2m', variant_label: null, attrs: {} }).ok).toBe(true);
  });

  it('rejects HTML, the em dash, and names that are too short or too long', () => {
    const src = { title: 'Philips Kettle 1.7L', brand: 'Philips' };
    expect(checkName(src, { display_name: 'Philips <b>Kettle</b> 1.7L', variant_label: null, attrs: {} }).ok).toBe(false);
    expect(checkName(src, { display_name: 'Philips Kettle \u2014 1.7L', variant_label: null, attrs: {} }).ok).toBe(false);
    expect(checkName({ title: 'X1', brand: null }, { display_name: 'X1', variant_label: null, attrs: {} }).ok).toBe(false);
    expect(checkName(src, { display_name: `Philips Kettle 1.7L ${'a'.repeat(140)}`, variant_label: null, attrs: {} }).ok).toBe(false);
  });

  it('rejects a name that is only the variant label', () => {
    const r = checkName({ title: 'Nike T-Shirt Black', brand: null }, { display_name: 'Black', variant_label: 'Black', attrs: {} });
    expect(r.ok).toBe(false);
  });

  it('counts tokens moved to the variant label as kept', () => {
    const src = { title: 'Apple iPhone 15 128GB Black', brand: 'Apple' };
    expect(checkName(src, { display_name: 'Apple iPhone 15', variant_label: '128GB, Black', attrs: {} }).ok).toBe(true);
    expect(checkName(src, { display_name: 'Apple iPhone 15', variant_label: 'Black', attrs: { storage_gb: 128 } }).ok).toBe(false);
  });

  it('keeps single-digit numbers and model words (Pixel 9 Pro)', () => {
    const src = { title: 'Google Pixel 9 Pro 128GB', brand: 'Google' };
    expect(checkName(src, { display_name: 'Google Pixel 9 Pro 128GB', variant_label: null, attrs: {} }).ok).toBe(true);
    expect(checkName(src, { display_name: 'Google Pixel Pro 128GB', variant_label: null, attrs: {} }).ok).toBe(false);
    expect(checkName(src, { display_name: 'Google Pixel 9 128GB', variant_label: null, attrs: {} }).ok).toBe(false);
  });

  it('compares numbers with units by value, so 512SSD is kept by 512 GB and 15,6" by 15.6"', () => {
    expect(checkName({ title: 'HP 250 G9 15,6" 8GB 512SSD', brand: 'HP' }, { display_name: 'HP 250 G9 15.6" 8 GB 512 GB SSD', variant_label: null, attrs: {} }).ok).toBe(true);
    expect(checkName({ title: 'HP 250 G9 15.6"', brand: 'HP' }, { display_name: 'HP 250 G9 15"', variant_label: null, attrs: {} }).ok).toBe(false);
  });

  it('accepts the recorded haiku answer for an ASUS title with bare spec numbers (I5/8/512)', () => {
    const src = { title: 'ASUS VIVOBOOK 16X K3605VC 16" I5/8/512/RTX 3050/W11P', brand: null };
    const answer = { display_name: 'ASUS VivoBook 16X K3605VC 16" RTX 3050', variant_label: '8GB, 512GB', attrs: { cpu: 'I5', gpu: 'RTX 3050', os: 'Windows' } };
    expect(checkName(src, answer)).toEqual({ ok: true });
    expect(checkName(src, { ...answer, variant_label: '8GB' }).ok).toBe(false);
  });

  it('lets barcode-like digit runs (8 or more digits) go', () => {
    expect(checkName({ title: 'Philips Kettle 1.7L (8710103123456)', brand: 'Philips' }, { display_name: 'Philips Kettle 1.7L', variant_label: null, attrs: {} }).ok).toBe(true);
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

  it('drops text with HTML and skips nulls silently', () => {
    const r = checkAttrs({ cpu: '<b>i5</b>', gpu: null }, laptops);
    expect(r.attrs).toEqual({});
    expect(r.dropped).toEqual(['cpu (bad text)']);
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
      { key: '2', group: group({ groupKey: 'b', title: 'Acer Aspire 5 A515' }) },
    ],
  };

  it('rejects a missing item and ignores answers with unknown keys', () => {
    const out = { items: [{ key: '1', display_name: 'Lenovo ThinkBook 16 G6 16GB 512GB', variant_label: null, attrs: LENOVO_ATTRS }, { key: '99', display_name: 'x', variant_label: null, attrs: {} }] };
    const r = checkBatch(batch, out, laptops);
    expect(r.results.map((x) => [x.item.key, x.status])).toEqual([['1', 'ok'], ['2', 'rejected']]);
    expect(r.results[1].reason).toBe('missing from answer');
    expect(r.unknownKeys).toEqual(['99']);
    expect(r.results[0].displayName).toBe('Lenovo ThinkBook 16 G6 16GB 512GB');
  });

  it('stores no name and no attrs for a rejected item but keeps the proposal for the report', () => {
    const out = { items: [
      { key: '1', display_name: 'Lenovo ThinkBook', variant_label: null, attrs: LENOVO_ATTRS },
      { key: '2', display_name: 'Acer Aspire 5 A515', variant_label: null, attrs: { bogus: 1 } },
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
