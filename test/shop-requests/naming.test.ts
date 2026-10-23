// Shop name and slug for a requested shop (src/shop-requests/naming.ts).
import { describe, expect, it } from 'vitest';
import { siteNameFromHtml, slugFromHost } from '../../src/shop-requests/naming.js';

describe('siteNameFromHtml', () => {
  it('prefers og:site_name, decoded and trimmed', () => {
    const html = `<html><head><title>Home | Ignored</title><meta property="og:site_name" content="  Bits &amp; Bobs  Malta "></head></html>`;
    expect(siteNameFromHtml(html)).toBe('Bits & Bobs Malta');
  });

  it('falls back to the title, dropping a Home part', () => {
    expect(siteNameFromHtml('<title>Home | Klikk Malta</title>')).toBe('Klikk Malta');
    expect(siteNameFromHtml('<title>Gadget Store &#8211; Home</title>')).toBe('Gadget Store');
    expect(siteNameFromHtml('<title>\n  Gadget &quot;Store&quot;\n</title>')).toBe('Gadget "Store"');
  });

  it('cuts to 80 characters and gives null when there is no name', () => {
    expect(siteNameFromHtml(`<title>${'x'.repeat(120)}</title>`)).toHaveLength(80);
    expect(siteNameFromHtml('<html><body>no title</body></html>')).toBeNull();
    expect(siteNameFromHtml('<title>   </title>')).toBeNull();
  });

  it('keeps markup in a name as text', () => {
    expect(siteNameFromHtml('<meta property="og:site_name" content="&lt;b&gt;Shop&lt;/b&gt;">')).toBe('<b>Shop</b>');
  });
});

describe('slugFromHost', () => {
  it('drops www. and the public suffix', () => {
    expect(slugFromHost('www.klikk.com.mt', new Set())).toBe('klikk');
    expect(slugFromHost('gamestore.mt', new Set())).toBe('gamestore');
    expect(slugFromHost('online.squaredeal.com.mt', new Set())).toBe('online-squaredeal');
    expect(slugFromHost('shop.example.co.uk', new Set())).toBe('shop-example');
    expect(slugFromHost('xn--bcher-kva.mt', new Set())).toBe('xn--bcher-kva');
  });

  it('adds a number when the slug is taken', () => {
    expect(slugFromHost('klikk.com.mt', new Set(['klikk']))).toBe('klikk-2');
    expect(slugFromHost('klikk.com.mt', new Set(['klikk', 'klikk-2']))).toBe('klikk-3');
  });

  it('always gives a slug the admin API accepts', () => {
    for (const host of ['a.mt', `${'long'.repeat(30)}.com.mt`, 'x--y.mt']) expect(slugFromHost(host, new Set())).toMatch(/^[a-z0-9-]{1,64}$/);
  });
});
