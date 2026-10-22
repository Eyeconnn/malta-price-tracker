// Browser formatting, shared with the server's verdict sentences so both read the same.
import { formatDay as formatMaltaDay, maltaDay } from '../../../src/site/verdict.js';

/** "€1,219.00" for 121900 cents. */
export { formatEuro } from '../../../src/site/verdict.js';

/** "+12.7%" / "-2.7%" / "0%"; one decimal at most, whole numbers stay whole. */
export function signedPct(pct: number): string {
  const abs = Number(Math.abs(pct).toFixed(1));
  return `${pct > 0 ? '+' : pct < 0 ? '-' : ''}${abs}%`;
}

/** "22 Oct" for a YYYY-MM-DD Malta day, or for the Malta day of a full ISO timestamp. */
export function formatDay(iso: string): string {
  return formatMaltaDay(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : maltaDay(new Date(iso)));
}
