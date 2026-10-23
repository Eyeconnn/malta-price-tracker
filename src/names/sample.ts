// --sample-from: the exact groups of an earlier run's CSV report, so models and fixes are compared on the same groups.
// CSVs written since this change carry shop_id and group_key; older ones are matched on shop slug and shop title.
import type { GroupInput } from './select.js';

export type SampleRow = { category: string; shop: string; sourceTitle: string; shopId: number | null; groupKey: string | null };

/** RFC 4180 CSV (quotes, doubled quotes, CRLF or LF), a leading BOM ignored. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** renderCsv puts an apostrophe before a cell a spreadsheet would read as a formula; this takes it off again. */
const unguard = (v: string) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);

/** The groups listed in a report CSV of this script. */
export function readSampleCsv(text: string): SampleRow[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const col = (name: string) => header.indexOf(name);
  const [cat, shop, title, shopId, groupKey] = ['category', 'shop', 'source_title', 'shop_id', 'group_key'].map(col);
  if (shop < 0 || title < 0) throw new Error('not a normalise-names report CSV: no shop and source_title columns');
  return rows
    .filter((r) => r.length > 1)
    .map((r) => {
      const id = shopId >= 0 ? unguard(r[shopId] ?? '') : '';
      const key = groupKey >= 0 ? unguard(r[groupKey] ?? '') : '';
      return {
        category: cat >= 0 ? unguard(r[cat] ?? '') : '',
        shop: unguard(r[shop] ?? ''),
        sourceTitle: unguard(r[title] ?? ''),
        shopId: /^\d+$/.test(id) ? Number(id) : null,
        groupKey: key !== '' ? key : null,
      };
    });
}

export type SamplePick = {
  /** the matched groups, in the CSV's order, each group once */
  chosen: GroupInput[];
  matched: number;
  /** of matched, how many by shop_id and group_key (the rest by shop and title) */
  byIds: number;
  /** CSV rows with no fresh group */
  missing: SampleRow[];
  /** matched groups whose category today differs from the CSV's */
  changedCategory: { from: string; to: string; group: GroupInput }[];
};

/** Picks the groups of a sample CSV out of the loaded groups. */
export function pickSample(groups: GroupInput[], rows: SampleRow[]): SamplePick {
  const byIds = new Map(groups.map((g) => [`${g.shopId}|${g.groupKey}`, g]));
  const byTitle = new Map<string, GroupInput[]>();
  for (const g of groups) {
    const k = `${g.shopSlug}|${g.title}`;
    const list = byTitle.get(k);
    if (list) list.push(g);
    else byTitle.set(k, [g]);
  }
  const used = new Set<GroupInput>();
  const pick: SamplePick = { chosen: [], matched: 0, byIds: 0, missing: [], changedCategory: [] };
  for (const r of rows) {
    let g: GroupInput | undefined;
    if (r.shopId !== null && r.groupKey !== null) {
      g = byIds.get(`${r.shopId}|${r.groupKey}`);
      if (g && used.has(g)) g = undefined;
      if (g) pick.byIds++;
    }
    g ??= (byTitle.get(`${r.shop}|${r.sourceTitle}`) ?? []).find((x) => !used.has(x));
    if (!g) {
      pick.missing.push(r);
      continue;
    }
    used.add(g);
    pick.chosen.push(g);
    pick.matched++;
    if (r.category !== '' && r.category !== g.category) pick.changedCategory.push({ from: r.category, to: g.category, group: g });
  }
  return pick;
}
