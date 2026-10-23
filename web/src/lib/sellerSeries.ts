// How each seller's line looks on the product page chart, shared by the (lazy) chart and its legend so the
// legend never needs Recharts. Colour and dash pattern both differ, so lines stay apart without colour.

export const SERIES_MAX = 6;

const COLOURS = ['var(--accent)', 'var(--ink)', 'var(--good)', 'var(--bad)', 'var(--muted)', 'var(--accent)'];
const DASHES = ['', '6 4', '2 3', '10 3 2 3', '1 3', '12 6'];

/** The stroke of the i-th seller's line (i < SERIES_MAX). */
export function seriesStyle(i: number): { stroke: string; dash: string } {
  return { stroke: COLOURS[i % COLOURS.length]!, dash: DASHES[i % DASHES.length]! };
}

/** A seller's was price is drawn as a thin, faded, finely dotted line in the seller's own colour. */
export const WAS_DASH = '1 4';

/** Whether a seller's readings ever show a was price (only then is its was line drawn). */
export function hasWas(line: { rows: { was: number | null }[] }): boolean {
  return line.rows.some((r) => typeof r.was === 'number' && r.was > 0);
}
