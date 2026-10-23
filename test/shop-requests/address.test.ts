// Shop address rules for the Add shop page (src/shop-requests/address.ts), shared by the Worker and the form.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADDRESS_PROBLEM_TEXT, SHOP_CATEGORIES, cleanDisplayName, hostKey, parseShopAddress } from '../../src/shop-requests/address.js';

const ok = (raw: string) => {
  const r = parseShopAddress(raw);
  if (!r.ok) throw new Error(`${raw}: ${r.problem}`);
  return r;
};
const problem = (raw: string) => {
  const r = parseShopAddress(raw);
  return r.ok ? null : r.problem;
};

describe('parseShopAddress', () => {
  it('keeps only the origin of a good address, lowercased', () => {
    expect(ok('https://www.Example.com.mt/shop/item?x=1#top')).toEqual({ ok: true, origin: 'https://www.example.com.mt', host: 'example.com.mt' });
    expect(ok('http://shop.example.mt').origin).toBe('http://shop.example.mt');
    expect(ok('  https://example.com.mt/  ').origin).toBe('https://example.com.mt');
  });

  it('adds https:// when no scheme is typed', () => {
    expect(ok('example.com.mt').origin).toBe('https://example.com.mt');
    expect(ok('www.example.com.mt/products').origin).toBe('https://www.example.com.mt');
    expect(ok('//example.com.mt').origin).toBe('https://example.com.mt');
  });

  it('allows only the default port of the scheme, so an origin never carries a port', () => {
    expect(ok('https://example.com.mt:443/').origin).toBe('https://example.com.mt');
    expect(ok('http://example.com.mt:80/').origin).toBe('http://example.com.mt');
    expect(problem('http://example.com.mt:443/')).toBe('port');
    expect(problem('https://example.com.mt:80/')).toBe('port');
    expect(problem('https://example.com.mt:8080/')).toBe('port');
    expect(problem('http://example.com.mt:22')).toBe('port');
  });

  it('normalises international host names to punycode and drops a trailing dot', () => {
    expect(ok('https://bücher.example.mt/').origin).toBe('https://xn--bcher-kva.example.mt');
    expect(ok('https://example.com.mt./').host).toBe('example.com.mt');
  });

  it('refuses other schemes', () => {
    for (const raw of ['ftp://example.com.mt', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'mailto:a@example.com.mt']) {
      expect(problem(raw), raw).toBe('scheme');
    }
  });

  it('refuses credentials', () => {
    expect(problem('https://user:pass@example.com.mt/')).toBe('credentials');
    expect(problem('https://user@example.com.mt/')).toBe('credentials');
  });

  it('refuses IP addresses in every spelling, IPv4 and IPv6', () => {
    for (const raw of [
      'http://127.0.0.1/',
      'http://10.0.0.1',
      'https://8.8.8.8/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://0x7f.0.0.1/',
      'http://0177.0.0.1/',
      'http://127.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[2001:db8::1]:443/',
      'http://[fe80::1%25eth0]/',
    ]) {
      expect(problem(raw), raw).toBe('ip');
    }
  });

  it('refuses names that are not public host names', () => {
    for (const raw of [
      'http://localhost/',
      'http://localhost:3000/',
      'https://intranet/',
      'https://printer.local/',
      'https://db.internal/',
      'https://app.localhost/',
      'https://site.test/',
      'https://box.lan/',
      'https://under_score.example.mt/',
      'https://-dash.example.mt/',
      'https://example.123/',
      `https://${'a'.repeat(64)}.example.mt/`,
    ]) {
      expect(problem(raw), raw).not.toBeNull();
    }
    expect(problem('http://localhost/')).toBe('host');
    // a public suffix alone is not a shop
    for (const raw of ['https://com.mt', 'https://www.com.mt', 'http://co.uk', 'https://gov.mt', 'https://org.mt', 'https://edu.mt', 'https://net.mt', 'https://www.mt']) {
      expect(problem(raw), raw).toBe('host');
    }
    expect(ok('https://shop.com.mt').host).toBe('shop.com.mt');
    expect(problem('https://printer.local/')).toBe('host');
  });

  it('refuses empty, too long and malformed input', () => {
    expect(problem('')).toBe('empty');
    expect(problem('   ')).toBe('empty');
    expect(problem(`https://example.com.mt/${'a'.repeat(2100)}`)).toBe('too-long');
    expect(problem('https://exa mple.com.mt')).toBe('malformed');
    expect(problem('https://')).toBe('malformed');
    expect(problem('https://example.com.mt/\u0000')).toBe('malformed');
  });

  it('has a sentence for every problem', () => {
    for (const p of ['empty', 'too-long', 'malformed', 'scheme', 'credentials', 'port', 'ip', 'host'] as const) {
      expect(ADDRESS_PROBLEM_TEXT[p]).toMatch(/\.$/);
    }
  });
});

describe('hostKey', () => {
  it('compares hosts without www., case or trailing dot', () => {
    expect(hostKey('https://www.Klikk.com.mt/')).toBe('klikk.com.mt');
    expect(hostKey('https://klikk.com.mt')).toBe('klikk.com.mt');
    expect(hostKey('https://www.scanmalta.com/shop')).toBe('scanmalta.com');
    expect(hostKey('shop.example.mt.')).toBe('shop.example.mt');
  });
});

describe('cleanDisplayName', () => {
  it('strips bidi overrides and zero-width characters', () => {
    const c = (...codes: number[]) => String.fromCharCode(...codes);
    expect(cleanDisplayName(['Shop', c(0x202e), 'evil', c(0x202c)].join(''))).toBe('Shopevil');
    expect(cleanDisplayName([c(0x2066), 'A', c(0x2069), ' B', c(0x200b), 'C', c(0xfeff), c(0x200f), c(0x2060)].join(''))).toBe('A BC');
    expect(cleanDisplayName(c(0x200b, 0x200c, 0x200d))).toBeNull();
  });

  it('trims, collapses spaces and strips control characters; null when blank', () => {
    expect(cleanDisplayName('  Klikk   Malta ')).toBe('Klikk Malta');
    expect(cleanDisplayName('A\u0000B\tC')).toBe('AB C');
    expect(cleanDisplayName('   ')).toBeNull();
    expect(cleanDisplayName(null)).toBeNull();
    expect(cleanDisplayName(undefined)).toBeNull();
  });
});

describe('SHOP_CATEGORIES', () => {
  it('covers every category used in shops.seed.json', () => {
    const seed = JSON.parse(readFileSync('shops.seed.json', 'utf8')) as { shops: { category: string | null }[] };
    for (const s of seed.shops) if (s.category) expect(SHOP_CATEGORIES).toContain(s.category);
  });
});
