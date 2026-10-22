// Site settings the Worker needs on every request (only `public` for now), cached per isolate.
import { neon } from '@neondatabase/serverless';

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
 * Anything but a stored JSON `true` means private. A failed query also means private, cached for
 * 10 seconds. Concurrent cold requests share one query.
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
      console.error('site settings unavailable, treating the site as private', (e as Error).message);
      result = { settings: { public: false }, until: now + FAILURE_TTL_MS };
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
}
