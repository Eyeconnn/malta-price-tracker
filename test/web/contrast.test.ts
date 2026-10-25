// WCAG AA contrast of the design tokens in web/src/styles.css, both themes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];

const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8');

/** Light tokens: the :root block outside `@variant dark`; dark tokens: inside it. */
function themes(): { light: Map<string, string>; dark: Map<string, string> } {
  const start = css.indexOf(':root {');
  const variant = css.indexOf('@variant dark {', start);
  const variantEnd = css.indexOf('}', variant);
  if (start < 0 || variant < 0 || variantEnd < 0) throw new Error('token blocks not found in styles.css');
  const decls = (text: string) => new Map([...text.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  return { light: decls(css.slice(start, variant)), dark: decls(css.slice(variant, variantEnd)) };
}

function parse(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return { rgb: [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb, alpha: 1 };
  const rgba = /^rgba\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)$/.exec(value);
  if (rgba) return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: Number(rgba[4]) };
  throw new Error(`unsupported colour ${value}`);
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function over(fg: { rgb: Rgb; alpha: number }, bg: Rgb): Rgb {
  return fg.rgb.map((c, i) => c * fg.alpha + bg[i]! * (1 - fg.alpha)) as Rgb;
}

const { light, dark } = themes();

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme tokens', (_name, tokens) => {
  const color = (name: string): Rgb => {
    // a dark value that is not redefined keeps the light one (--white, --white-muted)
    const v = tokens.get(name) ?? light.get(name);
    if (!v) throw new Error(`missing ${name}`);
    return parse(v).rgb;
  };
  const bg = color('--bg');
  const glass = over(parse(tokens.get('--glass')!), bg);

  const textTokens = [
    '--ink',
    '--muted',
    '--faint',
    '--good',
    '--bad',
    '--accent',
    '--warn',
    '--info',
    '--neutral',
    '--grade-a',
    '--grade-b',
    '--grade-c',
    '--grade-d',
    '--grade-e',
    '--grade-f',
  ];
  it.each(textTokens)('%s text is at least 4.5:1 on bg and on glass', (name) => {
    expect(ratio(color(name), bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(color(name), glass)).toBeGreaterThanOrEqual(4.5);
  });

  // Solid panels (search results, the More sheet, dropdown lists, chart tooltips) are --surface; text sits on it
  // and on glass boxes over it. The scrim behind dialogs only dims the page and carries no text.
  it.each(['--ink', '--muted', '--faint', '--good', '--bad', '--accent'])('%s text is at least 4.5:1 on the surface and on glass over it', (name) => {
    const surface = color('--surface');
    expect(ratio(color(name), surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(color(name), over(parse(tokens.get('--glass')!), surface))).toBeGreaterThanOrEqual(4.5);
  });

  it('the scrim darkens the page (alpha between 0.3 and 0.8)', () => {
    const { alpha } = parse(tokens.get('--scrim')!);
    expect(alpha).toBeGreaterThanOrEqual(0.3);
    expect(alpha).toBeLessThanOrEqual(0.8);
  });

  // filled controls: buttons, the selected segment pill (ink, green for good deals, red for deals to avoid), badges
  it.each([
    ['--accent-ink', '--accent'],
    ['--on-ink', '--ink'],
    ['--good-fill-ink', '--good-fill'],
    ['--bad-ink', '--bad-fill'],
  ])('%s text is at least 4.5:1 on %s', (fg, fill) => {
    expect(ratio(color(fg), color(fill))).toBeGreaterThanOrEqual(4.5);
  });

  // chips: verdict words and stock on their tinted grounds
  it.each([
    ['--good', '--good-bg'],
    ['--bad', '--bad-bg'],
    ['--warn', '--warn-bg'],
    ['--info', '--info-bg'],
    ['--neutral', '--neutral-bg'],
  ])('%s chip text is at least 4.5:1 on %s', (fg, ground) => {
    expect(ratio(color(fg), color(ground))).toBeGreaterThanOrEqual(4.5);
  });

  // The smoked top bar and bottom bar float over scrolling content: their white text must stay readable over the
  // page and over the most contrasting content that can pass under it (ink-coloured text).
  it.each(['--white', '--white-muted'])('%s nav text is at least 4.5:1 on the smoked bars over the page and over ink', (name) => {
    const smoke = parse(tokens.get('--smoke')!);
    for (const under of [bg, color('--ink')]) {
      const bar = over(smoke, under);
      expect(ratio(over(parse((tokens.get(name) ?? light.get(name))!), bar), bar)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the smoked bars are more opaque than glass', () => {
    expect(parse(tokens.get('--smoke')!).alpha).toBeGreaterThan(parse(tokens.get('--glass')!).alpha);
  });

  it('tag ink is at least 4.5:1 on its tag fill', () => {
    expect(ratio(color('--tag-good-ink'), color('--tag-good'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(color('--tag-bad-ink'), color('--tag-bad'))).toBeGreaterThanOrEqual(4.5);
  });

  // quiet boxes (the deal card facts, "not enough history") use ink text on the fill colour, over the page or glass
  it('ink text on fill is at least 4.5:1 over bg and glass', () => {
    const fill = parse(tokens.get('--fill')!);
    for (const under of [bg, glass]) expect(ratio(color('--ink'), over(fill, under))).toBeGreaterThanOrEqual(4.5);
  });

  it('crossed-out was price is at least 4.5:1 on its tag fill', () => {
    expect(ratio(color('--tag-good-was'), color('--tag-good'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(color('--tag-bad-was'), color('--tag-bad'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('price tag was price', () => {
  // The was-price colour is the token itself: no opacity on the struck-through text.
  it('uses the was tokens without opacity', () => {
    const rules = [...css.matchAll(/([^{}]*\bs)\s*\{([^{}]*)\}/g)].filter((m) => m[1]!.includes('.price-tag'));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , body] of rules) expect(body).not.toMatch(/opacity/);
    expect(css).toMatch(/\.price-tag-good \.price-tag-label s\s*\{[^}]*color:\s*var\(--tag-good-was\)/);
    expect(css).toMatch(/\.price-tag-avoid \.price-tag-label s\s*\{[^}]*color:\s*var\(--tag-bad-was\)/);
  });
});

describe('light theme accent buttons', () => {
  it('use white text', () => {
    expect(light.get('--accent-ink')).toBe('#fefefe');
  });
});
