import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/site/settings.js';
import { createSettingsCache, loadSiteSettings, resetSiteSettingsCache, searchSettingsCache } from '../../web/worker/settings.js';

describe('loadSiteSettings', () => {
  beforeEach(() => resetSiteSettingsCache());

  it('is public only when the stored value is true', async () => {
    expect(await loadSiteSettings('url', async () => [{ value: true }], 0)).toEqual({ public: true });
    resetSiteSettingsCache();
    expect(await loadSiteSettings('url', async () => [{ value: false }], 0)).toEqual({ public: false });
    resetSiteSettingsCache();
    expect(await loadSiteSettings('url', async () => [{ value: 'true' }], 0)).toEqual({ public: false });
    resetSiteSettingsCache();
    expect(await loadSiteSettings('url', async () => [], 0)).toEqual({ public: false });
  });

  it('treats the site as private when the query fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = async () => {
      throw new Error('db down');
    };
    expect(await loadSiteSettings('url', failing, 0)).toEqual({ public: false });
    err.mockRestore();
  });

  it('caches the result for 60 seconds', async () => {
    const query = vi.fn(async () => [{ value: true }]);
    await loadSiteSettings('url', query, 1_000);
    await loadSiteSettings('url', query, 60_999);
    expect(query).toHaveBeenCalledTimes(1);
    await loadSiteSettings('url', query, 61_000);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('caches a failure for 10 seconds, still private', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const query = vi
      .fn<() => Promise<{ value: unknown }[]>>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([{ value: true }]);
    expect(await loadSiteSettings('url', query, 0)).toEqual({ public: false });
    expect(await loadSiteSettings('url', query, 9_999)).toEqual({ public: false });
    expect(query).toHaveBeenCalledTimes(1);
    expect(await loadSiteSettings('url', query, 10_000)).toEqual({ public: true });
    expect(query).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('keeps the last known settings when a later query fails (final review I4)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const query = vi
      .fn<() => Promise<{ value: unknown }[]>>()
      .mockResolvedValueOnce([{ value: true }])
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([{ value: false }]);
    expect(await loadSiteSettings('url', query, 0)).toEqual({ public: true });
    // a public site stays public while the database is down: visitors get no password prompt
    expect(await loadSiteSettings('url', query, 60_000)).toEqual({ public: true });
    // the failure is cached briefly, then the query is tried again
    expect(await loadSiteSettings('url', query, 69_999)).toEqual({ public: true });
    expect(query).toHaveBeenCalledTimes(2);
    expect(await loadSiteSettings('url', query, 70_000)).toEqual({ public: false });
    expect(query).toHaveBeenCalledTimes(3);
    err.mockRestore();
  });

  it('shares one in-flight query between concurrent cold requests', async () => {
    let release!: (rows: { value: unknown }[]) => void;
    const query = vi.fn(() => new Promise<{ value: unknown }[]>((r) => (release = r)));
    const a = loadSiteSettings('url', query, 0);
    const b = loadSiteSettings('url', query, 0);
    release([{ value: true }]);
    expect(await Promise.all([a, b])).toEqual([{ public: true }, { public: true }]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('createSettingsCache (search thresholds per isolate, T11)', () => {
  const custom = { ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_SETTINGS.thresholds, cheaperPct: 7 } };

  it('loads once per 60 seconds and shares an in-flight load', async () => {
    const cache = createSettingsCache();
    const load = vi.fn(async () => custom);
    expect(await Promise.all([cache.get(load, 0), cache.get(load, 0)])).toEqual([custom, custom]);
    expect(await cache.get(load, 59_999)).toBe(custom);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.get(load, 60_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed load', async () => {
    const cache = createSettingsCache();
    const load = vi.fn<() => Promise<typeof custom>>().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(custom);
    await expect(cache.get(load, 0)).rejects.toThrow('db down');
    expect(await cache.get(load, 1)).toBe(custom);
  });

  it('is emptied by resetSiteSettingsCache (admin saved new settings)', async () => {
    const load = vi.fn(async () => custom);
    await searchSettingsCache.get(load, 0);
    resetSiteSettingsCache();
    await searchSettingsCache.get(load, 1);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
