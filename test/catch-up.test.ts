// The daytime photo catch-up (src/pipeline/catchUp.ts): the Malta deadline and the chunk loop.
import { describe, expect, it, vi } from 'vitest';
import { catchUpShop, deadlineFor } from '../src/pipeline/catchUp.js';

describe('deadlineFor (Malta time)', () => {
  // 26 Oct 2026, 09:00 UTC = 10:00 in Malta (winter time, UTC+1)
  const now = new Date('2026-10-26T09:00:00Z');

  it('gives the epoch ms of a later Malta time today', () => {
    expect(deadlineFor('12:30', now)).toBe(Date.parse('2026-10-26T11:30:00Z'));
  });

  it('reads 24:00 as the coming Malta midnight', () => {
    expect(deadlineFor('24:00', now)).toBe(Date.parse('2026-10-26T23:00:00Z'));
  });

  it('follows summer time (UTC+2)', () => {
    expect(deadlineFor('24:00', new Date('2026-07-01T09:00:00Z'))).toBe(Date.parse('2026-07-01T22:00:00Z'));
  });

  it('is null for a time that has passed or is not a time', () => {
    expect(deadlineFor('08:00', now)).toBeNull();
    expect(deadlineFor('10:00', now)).toBeNull();
    expect(deadlineFor('25:00', now)).toBeNull();
    expect(deadlineFor('12:75', now)).toBeNull();
    expect(deadlineFor('noon', now)).toBeNull();
  });
});

describe('catchUpShop', () => {
  const quiet = () => {};

  it('downloads chunk after chunk, refreshing the site after each, until a chunk stores nothing', async () => {
    const results = [500, 500, 120, 0];
    const download = vi.fn(async () => ({ downloaded: results.shift() ?? 0 }));
    const refresh = vi.fn(async () => 7);
    const res = await catchUpShop('alpha', Date.now() + 60_000, 500, { download, refresh, log: quiet });
    expect(download).toHaveBeenCalledTimes(4);
    expect(download.mock.calls[0]).toEqual([500, expect.any(Number)]);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(res).toEqual({ downloaded: 1120, shown: 21 });
  });

  it('passes the deadline on and stops once it has passed', async () => {
    let t = 1_000;
    const until = 2_000;
    const download = vi.fn(async (_n: number, end: number) => {
      expect(end).toBe(until);
      t += 600;
      return { downloaded: 10 };
    });
    const res = await catchUpShop('alpha', until, 50, { download, refresh: async () => 1, now: () => t, log: quiet });
    // 1000 -> 1600 -> 2200: two chunks, then the deadline has passed
    expect(download).toHaveBeenCalledTimes(2);
    expect(res.downloaded).toBe(20);
  });

  it('does nothing after the deadline', async () => {
    const download = vi.fn(async () => ({ downloaded: 5 }));
    await catchUpShop('alpha', 100, 50, { download, refresh: async () => 0, now: () => 200, log: quiet });
    expect(download).not.toHaveBeenCalled();
  });
});
