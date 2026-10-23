// Text helpers shared by the name checks (check.ts) and the brand rule (brand.ts): one way to read a title.

/** Unit spellings to one unit per class. 512SSD means 512GB. */
export const UNIT: Record<string, string> = {
  gb: 'gb', ssd: 'gb', hdd: 'gb', emmc: 'gb', gbssd: 'gb', gbhdd: 'gb', gbemmc: 'gb', tb: 'tb', tbssd: 'tb', tbhdd: 'tb', mb: 'mb', kb: 'kb',
  in: 'in', inch: 'in', inches: 'in',
  w: 'w', watt: 'w', watts: 'w', kw: 'kw', v: 'v', mah: 'mah', wh: 'wh',
  l: 'l', ltr: 'l', litre: 'l', liter: 'l', litres: 'l', liters: 'l', ml: 'ml', cl: 'cl', dl: 'dl',
  kg: 'kg', g: 'g', mg: 'mg', mm: 'mm', cm: 'cm', m: 'm', metre: 'm', meter: 'm', metres: 'm', meters: 'm', km: 'km',
  hz: 'hz', khz: 'khz', mhz: 'mhz', ghz: 'ghz', mp: 'mp', k: 'k', p: 'p', x: 'x', pcs: 'pcs', pc: 'pcs', db: 'db',
};

export const QUANTITY = /^(\d+(?:\.\d+)?)([a-z]*)$/;

/** UK spellings read as the US one, so colour and color (litre and liter, ...) are the same word. */
const SPELLING: Record<string, string> = {
  colour: 'color', colours: 'colors', coloured: 'colored', multicolour: 'multicolor', multicolours: 'multicolors',
  grey: 'gray', greys: 'grays', aluminium: 'aluminum', centre: 'center', centres: 'centers',
  litre: 'liter', litres: 'liters', metre: 'meter', metres: 'meters',
};

/**
 * Lower case, accents and trademark signs off, thousands separators and decimal commas read, inch marks written as
 * "in", and a size such as 40x30 or 40 x 30 (also with the multiplication sign) written "40 x 30".
 */
export function prep(s: string): string {
  return s
    .replace(/[\u2122\u2120\u00ae\u00a9]/g, ' ')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\u00d7/g, 'x')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/(\d)\s*(?:"|''|\u2032\u2032|\u2033|\u201d|\u201c)/g, '$1in ')
    .replace(/(\d)\s*x\s*(?=\d)/g, '$1 x ');
}

const spell = (t: string) => (Object.hasOwn(SPELLING, t) ? SPELLING[t] : t);

/** Tokens of prepped text; a number followed by a unit word becomes one token ("16 gb" is "16gb"). */
export function tokens(t: string): string[] {
  const raw = t
    .split(/[^\p{L}\p{N}.]+/u)
    .flatMap((x) => {
      const u = x.replace(/^\.+|\.+$/g, '');
      return QUANTITY.test(u) ? [u] : u.split('.');
    })
    .filter((x) => x !== '')
    .map(spell);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (/^\d+(?:\.\d+)?$/.test(raw[i]) && i + 1 < raw.length && Object.hasOwn(UNIT, raw[i + 1])) {
      out.push(raw[i] + raw[i + 1]);
      i++;
    } else out.push(raw[i]);
  }
  return out;
}

/** Letters and digits only, prepped: "GameStore.mt" is "gamestoremt". */
export const compact = (s: string) => prep(s).replace(/[^\p{L}\p{N}]+/gu, '');

/** Whether target is one token of the list or adjacent tokens written together. */
export function inRun(list: string[], target: string): boolean {
  if (target === '') return false;
  for (let i = 0; i < list.length; i++) {
    let s = '';
    for (let j = i; j < list.length && s.length < target.length; j++) {
      s += list[j];
      if (s === target) return true;
    }
  }
  return false;
}
