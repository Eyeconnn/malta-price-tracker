import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSiteSettings, resetSiteSettingsCache } from '../../web/worker/settings.js';

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
