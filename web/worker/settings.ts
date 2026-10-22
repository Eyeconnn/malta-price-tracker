// Site settings the Worker needs on every request (only `public` for now), cached per isolate; and the
// per-isolate cache of the full settings that search uses for its thresholds.
import { neon } from '@neondatabase/serverless';
import type { SiteSettings } from '../../src/site/settings.js';

export interface AccessSettings {
  public: boolean;
}

type Query = (databaseUrl: string) => Promise<{ value: unknown }[]>;

const TTL_MS = 60_000;
const FAILURE_TTL_MS = 10_000;
let cached: { settings: AccessSettings; until: number } | null = null;
let inflight: Promise<AccessSettings> | null = null;
/** Bumped by every reset, so a load that started before a reset cannot cache its (older) answer. */
let generation = 0;

const queryPublic: Query = async (databaseUrl) => {
  const sql = neon(databaseUrl);
  return (await sql`select value from site_settings where key = 'public'`) as { value: unknown }[];
};

/**
 * Reads `public` from site_settings with the read-only role, cached for 60 seconds.
 * Anything but a stored JSON `true` means private. A failed query keeps the last settings this isolate knew
 * (so a public site does not start asking visitors for a password while the database is down), and means
 * private when it knew none; either answer is cached for 10 seconds. Concurrent cold requests share one query.
 */
export function loadSiteSettings(databaseUrl: string, query: Query = queryPublic, now = Date.now()): Promise<AccessSettings> {
  if (cached && now < cached.until) return Promise.resolve(cached.settings);
  if (inflight) return inflight;
  const gen = generation;
  const load = (async () => {
    let result: { settings: AccessSettings; until: number };
    try {
      const rows = await query(databaseUrl);
      result = { settings: { public: rows[0]?.value === true }, until: now + TTL_MS };
    } catch (e) {
      const kept = cached?.settings ?? { public: false };
      console.error(`site settings unavailable, keeping the site ${kept.public ? 'public' : 'private'}`, (e as Error).message);
      result = { settings: kept, until: now + FAILURE_TTL_MS };
    }
    if (gen === generation) cached = result;
    return result.settings;
  })().finally(() => {
    if (inflight === load) inflight = null;
  });
  inflight = load;
  return load;
}

/** Forgets the cached settings in this isolate (admin saved new ones); other isolates follow within 60 seconds. */
export function resetSiteSettingsCache(): void {
  generation++;
  cached = null;
  inflight = null;
  searchSettingsCache.reset();
}

/** Full site settings cached for a while; a failed load is not kept (the caller sees its error). */
export interface SettingsCache {
  get(load: () => Promise<SiteSettings>, now?: number): Promise<SiteSettings>;
  reset(): void;
}

export function createSettingsCache(ttlMs = TTL_MS): SettingsCache {
  let entry: { settings: SiteSettings; until: number } | null = null;
  let pending: Promise<SiteSettings> | null = null;
  let gen = 0;
  return {
    get(load, now = Date.now()) {
      if (entry && now < entry.until) return Promise.resolve(entry.settings);
      if (pending) return pending;
      const started = gen;
      const p = load()
        .then((settings) => {
          if (started === gen) entry = { settings, until: now + ttlMs };
          return settings;
        })
        .finally(() => {
          if (pending === p) pending = null;
        });
      pending = p;
      return p;
    },
    reset() {
      gen++;
      entry = null;
      pending = null;
    },
  };
}

/** The settings /api/search reads its thresholds from: one load per isolate per 60 seconds, not one per call. */
export const searchSettingsCache = createSettingsCache();
