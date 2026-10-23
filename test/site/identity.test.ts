import { describe, expect, it } from 'vitest';
import raw from '../../config/attribute-schemas.json' with { type: 'json' };
import { loadAttributeSchemas } from '../../src/names/schema.js';
import { IDENTITY, nameKey, parseIdentity, specsSummary, withSpecs } from '../../src/site/identity.js';

describe('identity specs per category (config/attribute-schemas.json)', () => {
  it('lists the key specs of each category, never colour or size', () => {
    expect(IDENTITY.laptops.map((s) => s.key)).toEqual(['storage_gb', 'ram_gb', 'screen_in', 'cpu', 'gpu']);
    expect(IDENTITY.phones.map((s) => s.key)).toEqual(['storage_gb', 'ram_gb', 'screen_in', 'network']);
    expect(IDENTITY['tv-audio'].map((s) => s.key)).toContain('screen_in');
    expect(IDENTITY.toys.map((s) => s.key)).toEqual(['model', 'pieces']);
    expect(IDENTITY.drinks.find((s) => s.key === 'pack_count')).toMatchObject({ type: 'number', unit: 'items' });
    for (const specs of Object.values(IDENTITY)) for (const s of specs) expect(['colour', 'size', 'sizes']).not.toContain(s.key);
  });

  it('is not an attribute for the name normaliser', async () => {
    const schemas = await loadAttributeSchemas();
    expect(Object.keys(schemas.laptops)).not.toContain('identity');
    expect(Object.keys(schemas.laptops)).toContain('storage_gb');
  });

  it('refuses colour or size, unknown keys and a missing list', () => {
    const cats = (raw as { categories: Record<string, Record<string, unknown>> }).categories;
    const withLaptops = (identity: unknown) => ({ ...raw, categories: { ...cats, laptops: { ...cats.laptops, identity } } });
    expect(() => parseIdentity(withLaptops(['colour']))).toThrow(/colour/);
    expect(() => parseIdentity(withLaptops(['storage_tb']))).toThrow(/storage_tb/);
    expect(() => parseIdentity(withLaptops('storage_gb'))).toThrow(/laptops/);
    expect(() => parseIdentity({ ...raw, categories: { ...cats, toys: { ...cats.toys, identity: undefined } } })).toThrow(/toys/);
  });
});

describe('nameKey', () => {
  it('makes case, spacing, punctuation and unit spelling equal', () => {
    expect(nameKey('Samsung Galaxy S25 Ultra Smartphone 256 GB')).toBe(nameKey('SAMSUNG Galaxy S25-Ultra  smartphone, 256GB'));
    expect(nameKey('ASUS Vivobook 15 15.6" Notebook')).toBe(nameKey('Asus VivoBook 15 15.6 inch notebook'));
    expect(nameKey('Galaxy Tab S10')).toBe(nameKey('Galaxy Tab-S10'));
    expect(nameKey('Galaxy Tab S10')).toBe(nameKey('Galaxy TabS10'));
    expect(nameKey('Kettle 1.7 Litre Grey')).toBe(nameKey('Kettle 1.70L Gray'));
    expect(nameKey('Lenovo 512 SSD')).toBe(nameKey('Lenovo 512GB'));
    expect(nameKey('Black & Decker drill')).toBe(nameKey('Black and Decker Drill'));
    expect(nameKey('Café™ Crème')).toBe(nameKey('cafe creme'));
  });

  it('keeps what tells products apart', () => {
    expect(nameKey('Galaxy S25+')).not.toBe(nameKey('Galaxy S25'));
    expect(nameKey('Galaxy S25 Ultra')).not.toBe(nameKey('Galaxy S25'));
    expect(nameKey('Vivobook 15 1504')).not.toBe(nameKey('Vivobook 151 504'));
    expect(nameKey('iPhone 16 128GB')).not.toBe(nameKey('iPhone 16 128TB'));
    expect(nameKey('LEGO 42115')).not.toBe(nameKey('LEGO 42116'));
  });

  it('is empty for a name without letters or digits', () => {
    expect(nameKey(' -- ')).toBe('');
  });
});

describe('specsSummary and withSpecs (the display name)', () => {
  it('lists the identity specs the clean name does not have', () => {
    expect(specsSummary('phones', { storage_gb: 256 }, 'Samsung Galaxy S25 Ultra Smartphone')).toBe('256GB');
    expect(specsSummary('phones', { storage_gb: 512, ram_gb: 12 }, 'Samsung Galaxy S25 Ultra Smartphone')).toBe('512GB, 12GB RAM');
    expect(specsSummary('phones', { storage_gb: 1024 }, 'Apple iPhone 17 Pro')).toBe('1TB');
    expect(specsSummary('laptops', { storage_gb: 512, ram_gb: 16, screen_in: 15.6, cpu: 'Intel Core i5' }, 'Lenovo V15 G5 15.6" Intel Core i5 Notebook')).toBe(
      '512GB, 16GB RAM',
    );
    expect(specsSummary('drinks', { volume_ml: 330, pack_count: 6 }, 'Heineken Lager')).toBe('330ml, pack of 6');
    expect(specsSummary('drinks', { volume_ml: 330, pack_count: 6 }, 'Heineken Lager 330ml')).toBe('Pack of 6');
    expect(specsSummary('toys', { model: '42115', pieces: 3696 }, 'LEGO Technic 42115 Lamborghini')).toBe('3696 pieces');
    expect(specsSummary('tv-audio', { screen_in: 55, resolution: '4K' }, 'Samsung QE55Q60D 55" QLED TV')).toBe('4K');
  });

  it('is null when the name has every spec or there is none', () => {
    expect(specsSummary('phones', { storage_gb: 256 }, 'Samsung Galaxy S25 256GB')).toBeNull();
    expect(specsSummary('phones', {}, 'Samsung Galaxy S25')).toBeNull();
    expect(specsSummary('fashion', { colour: ['black'], sizes: ['M'] }, 'Nike Tee')).toBeNull();
    expect(specsSummary(null, { storage_gb: 256 }, 'Thing')).toBeNull();
  });

  it('shows the summary after a middle dot', () => {
    expect(withSpecs('Samsung Galaxy S25 Ultra Smartphone', '256GB')).toBe('Samsung Galaxy S25 Ultra Smartphone · 256GB');
    expect(withSpecs('Samsung Galaxy S25 Ultra Smartphone', null)).toBe('Samsung Galaxy S25 Ultra Smartphone');
  });
});
