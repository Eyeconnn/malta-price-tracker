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
    const v = tokens.get(name);
    if (!v) throw new Error(`missing ${name}`);
    return parse(v).rgb;
  };
  const bg = color('--bg');
  const glass = over(parse(tokens.get('--glass')!), bg);

  const textTokens = ['--ink', '--muted', '--good', '--bad', '--accent', '--grade-a', '--grade-b', '--grade-c', '--grade-d', '--grade-e', '--grade-f'];
  it.each(textTokens)('%s text is at least 4.5:1 on bg and on glass', (name) => {
    expect(ratio(color(name), bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(color(name), glass)).toBeGreaterThanOrEqual(4.5);
  });

  it('text on accent is at least 4.5:1', () => {
    expect(ratio(color('--accent-ink'), color('--accent'))).toBeGreaterThanOrEqual(4.5);
  });

  it('text on bad (the Black Friday avoid banner) is at least 4.5:1', () => {
    expect(ratio(color('--bad-ink'), color('--bad'))).toBeGreaterThanOrEqual(4.5);
  });

  // The sticky top bar floats over scrolling content: its text must stay readable over the page
  // and over the most contrasting content that can pass under it (ink-coloured text).
  it.each(['--ink', '--muted', '--accent'])('%s nav text is at least 4.5:1 on the top bar over the page and over ink', (name) => {
    const bar = parse(tokens.get('--bar')!);
    for (const under of [bg, color('--ink')]) expect(ratio(color(name), over(bar, under))).toBeGreaterThanOrEqual(4.5);
  });

  it('the top bar is more opaque than glass', () => {
    expect(parse(tokens.get('--bar')!).alpha).toBeGreaterThan(parse(tokens.get('--glass')!).alpha);
  });

  it('tag ink is at least 4.5:1 on its tag fill', () => {
    expect(ratio(color('--tag-gold-ink'), color('--tag-gold'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(color('--tag-red-ink'), color('--tag-red'))).toBeGreaterThanOrEqual(4.5);
  });

  it('crossed-out was price is at least 4.5:1 on its tag fill', () => {
    expect(ratio(color('--tag-gold-was'), color('--tag-gold'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(color('--tag-red-was'), color('--tag-red'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('price tag was price', () => {
  // The was-price colour is the token itself: no opacity on the struck-through text.
  it('uses the was tokens without opacity', () => {
    const rules = [...css.matchAll(/([^{}]*\bs)\s*\{([^{}]*)\}/g)].filter((m) => m[1]!.includes('.price-tag'));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , body] of rules) expect(body).not.toMatch(/opacity/);
    expect(css).toMatch(/\.price-tag-good \.price-tag-label s\s*\{[^}]*color:\s*var\(--tag-gold-was\)/);
    expect(css).toMatch(/\.price-tag-avoid \.price-tag-label s\s*\{[^}]*color:\s*var\(--tag-red-was\)/);
  });
});

describe('light theme accent buttons', () => {
  it('use white text', () => {
    expect(light.get('--accent-ink')).toBe('#ffffff');
  });
});
