// Site settings the Worker needs on every request (only `public` for now), cached per isolate.
import { neon } from '@neondatabase/serverless';

export interface SiteSettings {
  public: boolean;
}

type Query = (databaseUrl: string) => Promise<{ value: unknown }[]>;

const TTL_MS = 60_000;
let cached: { settings: SiteSettings; at: number } | null = null;

const queryPublic: Query = async (databaseUrl) => {
  const sql = neon(databaseUrl);
  return (await sql`select value from site_settings where key = 'public'`) as { value: unknown }[];
};

/**
 * Reads `public` from site_settings with the read-only role, cached for 60 seconds.
 * Anything but a stored JSON `true` means private; a failed query also means private (not cached).
 */
export async function loadSiteSettings(databaseUrl: string, query: Query = queryPublic, now = Date.now()): Promise<SiteSettings> {
  if (cached && now - cached.at < TTL_MS) return cached.settings;
  try {
    const rows = await query(databaseUrl);
    const settings = { public: rows[0]?.value === true };
    cached = { settings, at: now };
    return settings;
  } catch (e) {
    console.error('site settings unavailable, treating the site as private', (e as Error).message);
    return { public: false };
  }
}

export function resetSiteSettingsCache(): void {
  cached = null;
}
