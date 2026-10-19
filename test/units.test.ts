import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../src/http/safeNet.js';
import { parseJsonLenient } from '../src/http/fetcher.js';
import { applyIdentifierRules, blankRecord, cleanGtin, decodeEntities, minorToCents, toCents } from '../src/util/normalise.js';
import { reviewFlag } from '../src/pipeline/store.js';
import { parseRobots, productToken } from '../src/http/robots.js';

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '198.18.0.1', '192.0.0.8', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '64:ff9b::7f00:1', '2002:7f00:1::', 'not-an-ip'])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(['1.1.1.1', '23.227.38.65', '2606:4700::6810:84e5', '::ffff:1.1.1.1', '::ffff:101:101'])('allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('prices', () => {
  it('parses euro strings', () => {
    expect(toCents('69.00')).toBe(6900);
    expect(toCents('1,299.00')).toBe(129900);
    expect(toCents('€ 1.299,00')).toBe(129900);
    expect(toCents('12,50')).toBe(1250);
    expect(toCents('')).toBeNull();
    expect(minorToCents('3790', 2)).toBe(3790);
    expect(minorToCents('379', 1)).toBe(3790);
  });
  it('flags suspicious rows', () => {
    expect(reviewFlag(null, 100)).toBe('missing_price');
    expect(reviewFlag(0, 100)).toBe('zero_price');
    expect(reviewFlag(1000, 4000)).toBe('jump_70pct');
    expect(reviewFlag(1000, 1200)).toBeNull();
  });
});

describe('identifiers', () => {
  it('validates GTIN check digits', () => {
    expect(cleanGtin('4711387866801')).toBe('4711387866801');
    expect(cleanGtin('4711387866802')).toBeNull();
    expect(cleanGtin('6921042132518PK')).toBeNull();
  });
  it('applies per-shop rules', () => {
    const r = { ...blankRecord('1'), sku: 'PCA-RAZ-RZ0305930100' };
    applyIdentifierRules(r, { mpn_from_sku: '^[A-Z]{2,4}-[A-Z0-9]{1,5}-([A-Z0-9][A-Z0-9.\-/]{3,})$' });
    expect(r.mpn).toBe('RZ0305930100');
    const g = { ...blankRecord('2'), sku: '043859690695' };
    applyIdentifierRules(g, { sku_is_gtin: true });
    expect(g.gtin).toBe('043859690695');
  });
  it('decodes entities safely', () => {
    expect(decodeEntities('T&#8217;nB &amp; Co')).toBe('T’nB & Co');
    expect(decodeEntities('bad &#99999999; ok')).toBe('bad &#99999999; ok');
  });
});

describe('productToken', () => {
  it('reads the compatible token', () => {
    expect(productToken('Mozilla/5.0 (compatible; MTPIndex/1.0)')).toBe('mtpindex');
    expect(productToken('Foo/1.0 (+x)')).toBe('foo');
  });
});

describe('parsing', () => {
  it('strips HTML padding before JSON', () => {
    expect(parseJsonLenient('<div class="x"><p>In stock</p></div>\n[{"id":1}]')).toEqual([{ id: 1 }]);
  });
  it('reads robots groups for our token only', () => {
    const r = parseRobots('https://s.mt', 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /cart\nCrawl-delay: 5\n', 'MaltaPriceTracker/0.1 (x)');
    expect(r.isAllowed('https://s.mt/products.json')).toBe(true);
    expect(r.isAllowed('https://s.mt/cart')).toBe(false);
    expect(r.crawlDelayMs).toBe(5000);
  });
});
