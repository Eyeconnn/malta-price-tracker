// Site settings: code defaults, overridden by rows in site_settings (one row per top-level key).
import type postgres from 'postgres';

export type PhraseSlot = 'morning' | 'afternoon' | 'evening' | 'late' | 'bfweek';

export const PHRASE_SLOTS: readonly PhraseSlot[] = ['morning', 'afternoon', 'evening', 'late', 'bfweek'];

export type Thresholds = {
  minHistoryDays: number;
  baselineDays: number;
  raiseWindowDays: number;
  raisePct: number;
  goodDropPct: number;
  cheaperPct: number;
  minJudgedForRating: number;
};

export type SiteSettings = {
  public: boolean;
  thresholds: Thresholds;
  phrases: Record<PhraseSlot, string[]>;
  /** shop category text (lowercased) to site category slug */
  categoryOverrides: Record<string, string>;
};

// `*word*` marks the highlighted word in a headline; `{days}` is the days left to Black Friday.
export const DEFAULT_SETTINGS: SiteSettings = {
  public: false,
  thresholds: {
    minHistoryDays: 14,
    baselineDays: 30,
    raiseWindowDays: 14,
    raisePct: 3,
    goodDropPct: 5,
    cheaperPct: 2,
    minJudgedForRating: 20,
  },
  phrases: {
    morning: [
      'Coffee first, *receipts* second.',
      'Early bird gets the *real* discount.',
      "Good morning. Let's check that *was* price.",
    ],
    afternoon: [
      "Lunch-break shopping? Check it's *real*.",
      'That 50% off looks suspicious. *Let\'s see.*',
      'Is that deal *real*?',
    ],
    evening: [
      "Basket full? Let's see if it's *honest*.",
      'Prices change at night. *We watch.*',
      'Before you click buy, *check here*.',
    ],
    late: [
      "Can't sleep? Neither can our *price checker*.",
      '2am shopping is how they get you. *Check first.*',
      "The tags change while you sleep. *We don't.*",
    ],
    // {days} becomes "5 days" or "1 day" (whole Malta days to 27 Nov); lines with it are skipped on the day itself.
    bfweek: [
      '*{days}* to Black Friday. Prices are already moving.',
      '*Black Friday* week. Trust the tag, not the banner.',
      'Black Friday prices are moving. *Which deals are real?*',
    ],
  },
  categoryOverrides: {},
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reads site_settings and deep-merges it over DEFAULT_SETTINGS. Missing or malformed keys fall back to defaults. */
export async function loadSettings(sql: postgres.Sql): Promise<SiteSettings> {
  return settingsFromRows(await sql<{ key: string; value: unknown }[]>`select key, value from site_settings`);
}

/** Deep-merges site_settings rows over DEFAULT_SETTINGS (shared with the Worker, which reads the rows with its own driver). */
export function settingsFromRows(rows: readonly { key: string; value: unknown }[]): SiteSettings {
  const stored = new Map(rows.map((r) => [r.key, r.value]));

  const thresholds: Thresholds = { ...DEFAULT_SETTINGS.thresholds };
  const t = stored.get('thresholds');
  if (isObject(t)) {
    for (const k of Object.keys(thresholds) as (keyof Thresholds)[]) {
      const v = t[k];
      if (typeof v === 'number' && Number.isFinite(v)) thresholds[k] = v;
    }
  }

  const phrases = {} as Record<PhraseSlot, string[]>;
  const p = stored.get('phrases');
  for (const slot of PHRASE_SLOTS) {
    const v = isObject(p) ? p[slot] : undefined;
    phrases[slot] = Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') ? [...(v as string[])] : [...DEFAULT_SETTINGS.phrases[slot]];
  }

  const o = stored.get('categoryOverrides');
  const categoryOverrides: Record<string, string> = {};
  if (isObject(o)) for (const [k, v] of Object.entries(o)) if (typeof v === 'string') categoryOverrides[k] = v;

  const pub = stored.get('public');
  return {
    public: typeof pub === 'boolean' ? pub : DEFAULT_SETTINGS.public,
    thresholds,
    phrases,
    categoryOverrides,
  };
}
