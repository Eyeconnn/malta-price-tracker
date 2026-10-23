// The reviewer's adversarial pairs of the re-review of 82f7062/361f083 (N1-N42), kept as fixtures so later rounds
// keep them: two listings of different products must never share a name-match key (category, checked canonical
// name, title guard). One pair (N35, Mac mini written mini-M4) is the same product and must keep matching.
import { describe, expect, it } from 'vitest';
import { checkCanonical } from '../../src/names/canonical.js';
import { guardOf } from '../../src/site/matching.js';
import { PAIRS, SAME, type L } from './adversarial-pairs.js';

/** The name-match key of a listing, or null when it gets no canonical name. */
function key(x: L): string | null {
  const r = checkCanonical({ title: x.title, brand: x.brand, variantTitles: x.variants, mpn: x.mpn }, x.cat, x.attrs);
  return r.ok ? `${x.cat}|${r.canonical}|${guardOf(x.title, x.cat, x.variants)}` : null;
}

const id = (what: string) => what.split(' ')[0];

describe('adversarial pairs: different products never share a name-match key', () => {
  for (const [what, a, b] of PAIRS.filter(([w]) => !SAME.has(id(w)))) {
    it(what, () => {
      const ka = key(a);
      const kb = key(b);
      expect(ka !== null && ka === kb, `${ka} / ${kb}`).toBe(false);
    });
  }
});

describe('adversarial pairs: the same product written two ways still matches', () => {
  for (const [what, a, b] of PAIRS.filter(([w]) => SAME.has(id(w)))) {
    it(what, () => {
      expect(key(a)).not.toBeNull();
      expect(key(a)).toBe(key(b));
    });
  }
});
