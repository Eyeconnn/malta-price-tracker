// The daytime photo catch-up (pnpm photos): downloads the photos the nightly scrape had no time for, at each shop's
// own pace (robots.txt, Crawl-delay and the shop's delays are the fetcher's; nothing is shortened), until a set
// Malta time or until the shop has nothing left to fetch.

/** Minutes past Malta midnight for a Date. */
function maltaMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return n('hour') * 60 + n('minute') + n('second') / 60;
}

/**
 * The epoch ms of `until` ("HH:MM", Malta time, "24:00" for midnight) today, or null when that time has passed or the
 * text is not a time. Today is the Malta day of `now`.
 */
export function deadlineFor(until: string, now: Date): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(until.trim());
  if (!m) return null;
  const target = Number(m[1]) * 60 + Number(m[2]);
  if (target > 24 * 60 || Number(m[2]) > 59) return null;
  const left = target - maltaMinutes(now);
  return left > 0 ? now.getTime() + Math.round(left * 60_000) : null;
}

export type CatchUpDeps = {
  /** one chunk of downloads for the shop (downloadImagesForShop with perRun and until) */
  download: (perRun: number, until: number) => Promise<{ downloaded: number }>;
  /** gives the shop's site rows their new photos (refreshSiteImageKeys) */
  refresh: () => Promise<number>;
  now?: () => number;
  log?: (m: string) => void;
};

/**
 * Downloads in chunks of `chunk` photos until `until`, refreshing the site rows after each chunk so photos show
 * during the day. Stops when a chunk stores nothing: the backlog is clear, or every remaining URL failed, or the
 * shop's fetcher gave up (a later run tries again).
 */
export async function catchUpShop(slug: string, until: number, chunk: number, deps: CatchUpDeps): Promise<{ downloaded: number; shown: number }> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(m));
  let downloaded = 0;
  let shown = 0;
  while (now() < until) {
    const res = await deps.download(chunk, until);
    downloaded += res.downloaded;
    if (res.downloaded > 0) shown += await deps.refresh();
    if (res.downloaded === 0) {
      log(`[${slug}] photo catch-up: nothing more to store now`);
      break;
    }
  }
  log(`[${slug}] photo catch-up: ${downloaded} photos stored, ${shown} site rows now show one`);
  return { downloaded, shown };
}
