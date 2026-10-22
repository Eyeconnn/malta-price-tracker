import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { DEFAULT_SETTINGS, loadSettings } from '../../src/site/settings.js';

// Minimal stand-in for the tagged-template client: returns the given site_settings rows.
function fakeSql(rows: { key: string; value: unknown }[]): postgres.Sql {
  return (async () => rows) as unknown as postgres.Sql;
}

describe('DEFAULT_SETTINGS', () => {
  it('has the agreed thresholds and starts private', () => {
    expect(DEFAULT_SETTINGS.public).toBe(false);
    expect(DEFAULT_SETTINGS.categoryOverrides).toEqual({});
    expect(DEFAULT_SETTINGS.thresholds).toEqual({
      minHistoryDays: 14,
      baselineDays: 30,
      raiseWindowDays: 14,
      raisePct: 3,
      goodDropPct: 5,
      cheaperPct: 2,
      minJudgedForRating: 20,
    });
  });

  it('has at least 3 phrases in each slot, with a highlighted word', () => {
    for (const slot of ['morning', 'afternoon', 'evening', 'late', 'bfweek'] as const) {
      const lines = DEFAULT_SETTINGS.phrases[slot];
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const l of lines) expect(l).toMatch(/\*[^*]+\*/);
    }
    expect(DEFAULT_SETTINGS.phrases.morning).toContain('Coffee first, *receipts* second.');
    expect(DEFAULT_SETTINGS.phrases.late).toContain('2am shopping is how they get you. *Check first.*');
  });

  it('contains no em dash', () => {
    expect(JSON.stringify(DEFAULT_SETTINGS)).not.toContain('\u2014');
  });
});

describe('loadSettings', () => {
  it('returns the defaults for an empty table', async () => {
    expect(await loadSettings(fakeSql([]))).toEqual(DEFAULT_SETTINGS);
  });

  it('merges stored thresholds key by key', async () => {
    const s = await loadSettings(fakeSql([{ key: 'thresholds', value: { raisePct: 4 } }]));
    expect(s.thresholds.raisePct).toBe(4);
    expect(s.thresholds).toEqual({ ...DEFAULT_SETTINGS.thresholds, raisePct: 4 });
    expect(s.phrases).toEqual(DEFAULT_SETTINGS.phrases);
  });

  it('uses stored top-level values and ignores unknown keys', async () => {
    const s = await loadSettings(
      fakeSql([
        { key: 'public', value: true },
        { key: 'categoryOverrides', value: { 'gaming chairs': 'gaming' } },
        { key: 'phrases', value: { morning: ['Hi *there*', 'a *b*', 'c *d*'] } },
        { key: 'bogus', value: 1 },
      ]),
    );
    expect(s.public).toBe(true);
    expect(s.categoryOverrides).toEqual({ 'gaming chairs': 'gaming' });
    expect(s.phrases.morning).toEqual(['Hi *there*', 'a *b*', 'c *d*']);
    expect(s.phrases.late).toEqual(DEFAULT_SETTINGS.phrases.late);
    expect('bogus' in s).toBe(false);
  });

  it('does not mutate the defaults', async () => {
    await loadSettings(fakeSql([{ key: 'thresholds', value: { raisePct: 9 } }]));
    expect(DEFAULT_SETTINGS.thresholds.raisePct).toBe(3);
  });
});
