import { describe, expect, it } from 'vitest';
import { agreedAttrs, attributeList, optionLabel, productName } from '../../src/site/product.js';

const listing = (shopSlug: string, displayName: string | null, attrs: Record<string, unknown> | null = {}, category: string | null = 'phones') => ({
  shopSlug,
  title: `shop title at ${shopSlug}`,
  displayName,
  category,
  attrs,
});

describe('productName', () => {
  it('takes the clean name most shops agree on, as most of them write it', () => {
    const p = productName(
      [
        listing('a', 'Samsung Galaxy S25 Ultra Smartphone', { storage_gb: 256 }),
        listing('b', 'SAMSUNG Galaxy S25 Ultra Smartphone', { storage_gb: 256, ram_gb: 12 }),
        listing('c', 'Samsung Galaxy S25 Ultra Smartphone', {}),
        listing('d', 'Samsung Galaxy S25 Ultra 5G', {}),
      ],
      'fallback',
    );
    expect(p.name).toBe('Samsung Galaxy S25 Ultra Smartphone');
    expect(p.category).toBe('phones');
    expect(p.attrs).toEqual({ storage_gb: 256, ram_gb: 12 });
  });

  it('on a tie takes the shortest name', () => {
    expect(productName([listing('a', 'Apple iPhone 16 Smartphone'), listing('b', 'Apple iPhone 16')], 'x').name).toBe('Apple iPhone 16');
  });

  it('falls back to the shop title when no listing has a clean name', () => {
    expect(productName([listing('a', null, null, null)], 'LENOVO V15 G5 IRL')).toEqual({ name: 'LENOVO V15 G5 IRL', category: null, attrs: {} });
  });
});

describe('agreedAttrs', () => {
  it('keeps values the listings agree on, unions lists and drops conflicts', () => {
    expect(
      agreedAttrs([
        { storage_gb: 256, colour: ['black'], network: '5G', brand: 'Samsung' },
        { storage_gb: 256, colour: ['blue', 'Black'], network: '4G' },
        { ram_gb: 12 },
        null,
      ]),
    ).toEqual({ storage_gb: 256, colour: ['black', 'blue'], ram_gb: 12, brand: 'Samsung' });
  });
});

describe('attributeList', () => {
  it('lists attributes in the category order with plain labels and units', () => {
    expect(attributeList('laptops', { brand: 'Lenovo', storage_gb: 1024, ram_gb: 16, screen_in: 15.6, cpu: 'Intel Core i5', os: 'Windows', colour: ['grey', 'black'] })).toEqual([
      { key: 'screen_in', label: 'Screen', value: '15.6"' },
      { key: 'cpu', label: 'Processor', value: 'Intel Core i5' },
      { key: 'ram_gb', label: 'Memory', value: '16GB' },
      { key: 'storage_gb', label: 'Storage', value: '1TB' },
      { key: 'os', label: 'Operating system', value: 'Windows' },
      { key: 'colour', label: 'Colours', value: 'Grey, Black' },
    ]);
    expect(attributeList('drinks', { volume_ml: 330, pack_count: 6, abv_pct: 5 })).toEqual([
      { key: 'volume_ml', label: 'Volume', value: '330ml' },
      { key: 'pack_count', label: 'Pack', value: '6 items' },
      { key: 'abv_pct', label: 'Alcohol', value: '5%' },
    ]);
  });

  it('leaves out unknown keys, bad values, HTML-looking text and an unknown category', () => {
    expect(attributeList('phones', { storage_gb: 'lots', foo: 1, model: '<b>x</b>', network: '5G' })).toEqual([{ key: 'network', label: 'Network', value: '5G' }]);
    expect(attributeList(null, { storage_gb: 1 })).toEqual([]);
    expect(attributeList('nope', { storage_gb: 1 })).toEqual([]);
  });
});

describe('optionLabel', () => {
  it('drops the identity specs from a variant label, so the colour is the option', () => {
    expect(optionLabel('512GB, 12GB, Grey', 'phones', { storage_gb: 512, ram_gb: 12 })).toBe('Grey');
    expect(optionLabel('128GB, 4GB, Dual SIM', 'phones', { storage_gb: 128, ram_gb: 4 })).toBe('Dual SIM');
    expect(optionLabel('42, Black', 'fashion', { sizes: ['42'] })).toBe('42, Black');
    expect(optionLabel('16GB, 1TB SSD', 'laptops', { ram_gb: 16, storage_gb: 1024 })).toBeNull();
    expect(optionLabel(null, 'phones', {})).toBeNull();
    expect(optionLabel('  ', 'phones', {})).toBeNull();
  });
});
