import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';
import { computeVerdict, formatDay, formatEuro, type Obs } from '../../src/site/verdict.js';

const T = DEFAULT_SETTINGS.thresholds;

// Noon UTC is 13:00 or 14:00 in Malta, so the Malta calendar day equals the date string.
function at(date: string, time = '12:00:00Z'): Date {
  return new Date(`${date}T${time}`);
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function obs(date: string, price: number | null, was: number | null = null, bf: boolean | null = false): Obs {
  return { at: at(date), price, was, inStock: price !== null, bf };
}

/** n consecutive days starting at `start`, all with the same values. */
function days(start: string, n: number, price: number | null, was: number | null = null, bf: boolean | null = false): Obs[] {
  return Array.from({ length: n }, (_, i) => obs(addDays(start, i), price, was, bf));
}

describe('formatting', () => {
  it('formats cents as euros with two decimals and thousands separators', () => {
    expect(formatEuro(70900)).toBe('€709.00');
    expect(formatEuro(123456)).toBe('€1,234.56');
    expect(formatEuro(5)).toBe('€0.05');
  });

  it('formats days as "22 Oct" in Malta time', () => {
    expect(formatDay('2026-10-22')).toBe('22 Oct');
    expect(formatDay('2026-09-03')).toBe('3 Sep');
  });
});

describe('computeVerdict', () => {
  it('flags the Lenovo price rise while marked Black Friday as avoid', () => {
    const history = [
      ...days('2026-10-06', 14, 70900, 73900, false),
      obs('2026-10-20', 70900, 73900, false),
      obs('2026-10-21', 70900, 73900, true),
      obs('2026-10-22', 79900, 88900, true),
    ];
    const v = computeVerdict(history, T, at('2026-10-22', '20:00:00Z'));
    expect(v.label).toBe('avoid');
    expect(v.facts.raisedFrom).toEqual({ price: 70900, at: '2026-10-21' });
    expect(v.facts.raisedTo?.price).toBe(79900);
    expect(v.facts.raisedTo?.at).toBe('2026-10-22');
    expect(v.reason).toBe('Price went from €709.00 on 21 Oct to €799.00 on 22 Oct while marked Black Friday.');
    expect(v.facts.wasRaisedFrom).toBe(73900);
    expect(v.facts.historyDays).toBe(17);
    expect(v.facts.low30).toBe(70900);
    expect(v.facts.usual).toBe(70900);
    expect(v.facts.realPct).toBe(12.7);
    expect(v.facts.claimedPct).toBe(-10.1);
    expect(v.facts.priceChanges).toBe(1);
    expect(v.facts.wasChanges).toBe(1);
  });

  it('gives good to a real drop below a steady 30-day baseline', () => {
    const history = [...days('2026-10-20', 30, 13999), obs('2026-11-19', 12999, 13999, true)];
    const v = computeVerdict(history, T, at('2026-11-19', '20:00:00Z'));
    expect(v.label).toBe('good');
    expect(v.facts.realPct).toBeCloseTo(-7.1, 5);
    expect(v.facts.claimedPct).toBeCloseTo(-7.1, 5);
    expect(v.facts.low30).toBe(13999);
    expect(v.facts.usual).toBe(13999);
    expect(v.reason.startsWith('€10.00 below its lowest price')).toBe(true);
    expect(v.reason).toBe('€10.00 below its lowest price in the 30 days before 19 Nov (€139.99).');
  });

  it('is insufficient with only 5 days of history', () => {
    const history = [...days('2026-10-18', 4, 13999), obs('2026-10-22', 12999, 13999, true)];
    const v = computeVerdict(history, T, at('2026-10-22', '20:00:00Z'));
    expect(v.label).toBe('insufficient');
    expect(v.facts.historyDays).toBe(5);
    expect(v.reason).toBe('Not enough history yet: 5 days tracked, 14 needed.');
  });

  it('is insufficient when the latest price is hidden (null) or zero, and never reports it as a deal', () => {
    const base = days('2026-10-01', 20, 49900, 59900, true);
    for (const latest of [null, 0]) {
      const v = computeVerdict([...base, obs('2026-10-21', latest, 59900, true)], T, at('2026-10-21', '20:00:00Z'));
      expect(v.label).toBe('insufficient');
      expect(v.reason).toBe('Price not shown by the shop.');
      expect(v.facts.realPct).toBeNull();
      expect(v.facts.claimedPct).toBeNull();
    }
  });

  it('flags a was-price rise eight days ago with the price unchanged as avoid', () => {
    const now = at('2026-11-10', '20:00:00Z');
    const raiseDay = '2026-11-02';
    const history = [...days('2026-10-20', 13, 24900, 29900), ...days(raiseDay, 9, 24900, 39900)];
    const v = computeVerdict(history, T, now);
    expect(v.label).toBe('avoid');
    expect(v.facts.wasRaisedFrom).toBe(29900);
    expect(v.facts.raisedFrom).toBeUndefined();
    expect(v.reason).toBe('Was price went from €299.00 on 1 Nov to €399.00 on 2 Nov while the price stayed at €249.00.');
    expect(v.facts.priceChanges).toBe(0);
    expect(v.facts.wasChanges).toBe(1);
  });

  it('gives none to a product not marked and with no was price, even after a price rise', () => {
    const history = [...days('2026-10-01', 15, 10000), obs('2026-10-16', 12000)];
    const v = computeVerdict(history, T, at('2026-10-16', '20:00:00Z'));
    expect(v.label).toBe('none');
    expect(v.reason).toBe('Not marked Black Friday and no discount claimed.');
  });

  it('counts daysWorthBuying as days at or below the 30-day low', () => {
    // 10 days at 100, 5 days at 90, 5 days at 110, then the current price 95 (started today).
    const history = [
      ...days('2026-10-01', 10, 10000),
      ...days('2026-10-11', 5, 9000),
      ...days('2026-10-16', 5, 11000),
      obs('2026-10-21', 9500),
    ];
    const v = computeVerdict(history, T, at('2026-10-21', '20:00:00Z'));
    expect(v.facts.low30).toBe(9000);
    expect(v.facts.daysWorthBuying).toBe(5);
    expect(v.facts.priceChanges).toBe(3);
  });

  it('collapses several observations on one Malta day to the last one, in any input order', () => {
    // 21 Oct 23:30 UTC is 22 Oct 01:30 in Malta (CEST), so it belongs to 22 Oct.
    const history: Obs[] = [
      ...days('2026-10-06', 15, 70900, 73900, false),
      { at: at('2026-10-21', '06:00:00Z'), price: 79900, was: 88900, inStock: true, bf: true },
      { at: at('2026-10-21', '20:00:00Z'), price: 70900, was: 73900, inStock: true, bf: true },
      { at: at('2026-10-21', '23:30:00Z'), price: 70900, was: 73900, inStock: true, bf: true },
    ].reverse();
    const v = computeVerdict(history, T, at('2026-10-22', '20:00:00Z'));
    // The 79900 hourly reading is not the last of its day, so there is no rise.
    expect(v.facts.historyDays).toBe(17);
    expect(v.facts.priceChanges).toBe(0);
    expect(v.label).toBe('none');
    expect(v.reason).toBe('Price has been €709.00 on every day we tracked since 6 Oct.');
  });

  it('flags a rise before the Black Friday marker, with a sentence that stays factual', () => {
    const history = [
      ...days('2026-10-01', 15, 70900),
      ...days('2026-10-16', 5, 79900),
      obs('2026-10-21', 79900, 88900, true),
    ];
    const v = computeVerdict(history, T, at('2026-10-21', '20:00:00Z'));
    expect(v.label).toBe('avoid');
    expect(v.facts.raisedFrom).toEqual({ price: 70900, at: '2026-10-15' });
    expect(v.reason).toBe('Price went from €709.00 on 15 Oct to €799.00 on 16 Oct, and it is now marked Black Friday.');
  });

  it('does not flag a rise of exactly raisePct percent, or a rise outside the window', () => {
    // Marked Black Friday with no was price, so only the rise rules apply.
    const exact = [...days('2026-10-01', 15, 10000), obs('2026-10-16', 10300, null, true)];
    expect(computeVerdict(exact, T, at('2026-10-16', '20:00:00Z')).label).toBe('none');

    const old = [...days('2026-10-01', 5, 10000), ...days('2026-10-06', 20, 12000), obs('2026-10-26', 12000, null, true)];
    const v = computeVerdict(old, T, at('2026-10-26', '20:00:00Z'));
    expect(v.label).toBe('none');
    expect(v.reason).toBe('Price €120.00 is 20.0% above its lowest price in the 5 days before 6 Oct (€100.00).');
  });

  it('flags a was price higher than any price charged in the previous baselineDays days', () => {
    const exact = [...days('2026-10-01', 15, 10000), obs('2026-10-16', 10300, 12000, true)];
    const e = computeVerdict(exact, T, at('2026-10-16', '20:00:00Z'));
    expect(e.label).toBe('avoid');
    expect(e.reason).toBe('Was price €120.00 is higher than any price charged since 1 Oct (highest €103.00).');
    expect(e.facts.wasRaisedFrom).toBeUndefined();
    expect(e.facts.raisedFrom).toBeUndefined();

    const old = [...days('2026-10-01', 5, 10000), ...days('2026-10-06', 20, 12000), obs('2026-10-26', 12000, 15000, true)];
    const v = computeVerdict(old, T, at('2026-10-26', '20:00:00Z'));
    expect(v.label).toBe('avoid');
    expect(v.reason).toBe('Was price €150.00 is higher than any price charged since 1 Oct (highest €120.00).');
  });

  it('flags a judged product less than goodDropPct below its baseline low when its was price was never charged', () => {
    const history = [...days('2026-10-01', 20, 10000), obs('2026-10-21', 9800, 12000, true)];
    const v = computeVerdict(history, T, at('2026-10-21', '20:00:00Z'));
    expect(v.label).toBe('avoid');
    expect(v.facts.realPct).toBe(-2);
    expect(v.reason).toBe('Was price €120.00 is higher than any price charged since 1 Oct (highest €100.00).');
  });

  it('gives none to a judged product that is less than goodDropPct below its baseline low', () => {
    const history = [...days('2026-10-01', 20, 10000), obs('2026-10-21', 9800, null, true)];
    const v = computeVerdict(history, T, at('2026-10-21', '20:00:00Z'));
    expect(v.label).toBe('none');
    expect(v.facts.realPct).toBe(-2);
    expect(v.reason).toBe('Price €98.00 is 2.0% below its lowest price in the 20 days before 21 Oct (€100.00).');
  });

  it('uses the median of the baseline days as the usual price, and a rise later undone is not avoid', () => {
    const history = [
      ...days('2026-10-01', 3, 9000),
      ...days('2026-10-04', 6, 10000),
      ...days('2026-10-10', 5, 12000),
      obs('2026-10-15', 8000, 12000, true),
    ];
    const v = computeVerdict(history, T, at('2026-10-15', '20:00:00Z'));
    expect(v.facts.usual).toBe(10000);
    expect(v.facts.low30).toBe(9000);
    // The rise to 120 on 10 Oct is undone: 80 is below the 90 seen at the start of the window.
    expect(v.label).toBe('good');
    expect(v.facts.raisedFrom).toBeUndefined();
    expect(v.reason).toBe('€10.00 below its lowest price in the 14 days before 15 Oct (€90.00).');
  });

  it('does not flag a rise that went back to the pre-raise price', () => {
    const history = [...days('2026-10-01', 15, 10000), ...days('2026-10-16', 3, 12000), obs('2026-10-19', 10000, 12000, true)];
    const v = computeVerdict(history, T, at('2026-10-19', '20:00:00Z'));
    expect(v.label).toBe('none');
    expect(v.facts.raisedFrom).toBeUndefined();
  });

  it('anchors the baseline on the latest was-price change, including a was price appearing', () => {
    // 150 (was 150) for 14 days, 100 from 3 Nov for 10 days, then on 13 Nov a was price of 140 and the marker.
    const history = [
      ...days('2026-10-20', 14, 15000, 15000),
      ...days('2026-11-03', 10, 10000),
      obs('2026-11-13', 10000, 14000, true),
    ];
    const v = computeVerdict(history, T, at('2026-11-13', '20:00:00Z'));
    expect(v.facts.low30).toBe(10000);
    expect(v.facts.realPct).toBe(0);
    expect(v.label).toBe('none');
  });

  it('measures rises net, so small daily steps still count', () => {
    const history = [
      ...days('2026-10-01', 15, 10000),
      obs('2026-10-16', 10300, 15000, true),
      obs('2026-10-17', 10600, 15000, true),
      obs('2026-10-18', 10900, 15000, true),
      obs('2026-10-19', 11200, 15000, true),
    ];
    const v = computeVerdict(history, T, at('2026-10-19', '20:00:00Z'));
    expect(v.label).toBe('avoid');
    expect(v.facts.raisedFrom).toEqual({ price: 10000, at: '2026-10-15' });
    expect(v.facts.raisedTo).toEqual({ price: 11200, at: '2026-10-19' });
    expect(v.reason).toBe('Price went from €100.00 on 15 Oct to €112.00 on 19 Oct while marked Black Friday.');
  });

  it('withholds good when the was price was raised within baselineDays, even outside the raise window', () => {
    const history = [
      ...days('2026-10-21', 5, 30000), // the highest price charged, so the was price below is not "never charged"
      ...days('2026-10-26', 5, 20000, 24000),
      ...days('2026-10-31', 20, 20000, 28000), // was raised 20 days before 20 Nov
      obs('2026-11-20', 18000, 28000, true),
    ];
    const v = computeVerdict(history, T, at('2026-11-20', '20:00:00Z'));
    expect(v.facts.low30).toBe(20000);
    expect(v.facts.realPct).toBe(-10);
    expect(v.label).toBe('none');
    expect(v.reason).toBe(
      'Price €180.00 is 10.0% below its lowest price in the 30 days before 20 Nov (€200.00), but the was price went from €240.00 on 30 Oct to €280.00 on 31 Oct.',
    );
  });

  it('returns no verdict facts that crash on an empty history', () => {
    const v = computeVerdict([], T, at('2026-10-22'));
    expect(v.label).toBe('insufficient');
    expect(v.facts.historyDays).toBe(0);
    expect(v.facts.low30).toBeNull();
    expect(v.facts.usual).toBeNull();
  });
});
