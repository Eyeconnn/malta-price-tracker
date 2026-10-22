// Guard: every animation in styles.css is switched off under prefers-reduced-motion.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
/** The reduced-motion block, up to its matching closing brace. */
function reducedBlock(): string {
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error('unterminated reduced-motion block');
}

/** Innermost rules (selector, body) in a piece of CSS. */
function rules(text: string): { selectors: string[]; body: string }[] {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(',').map((s) => s.trim()).filter(Boolean),
    body: m[2]!,
  }));
}

describe('prefers-reduced-motion', () => {
  it('has a reduced-motion block', () => {
    expect(start).toBeGreaterThanOrEqual(0);
  });

  it('shortens every animation and transition with a universal rule', () => {
    const universal = rules(reducedBlock()).find((r) => r.selectors.includes('*'));
    expect(universal?.selectors).toEqual(['*', '*::before', '*::after']);
    expect(universal?.body).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(universal?.body).toMatch(/animation-iteration-count:\s*1 !important/);
    expect(universal?.body).toMatch(/transition-duration:\s*0\.01ms !important/);
  });

  it('turns off by name every selector that declares an animation', () => {
    const block = reducedBlock();
    const off = new Set(rules(block).filter((r) => /animation:\s*none !important/.test(r.body)).flatMap((r) => r.selectors));
    const outside = css.slice(0, start) + css.slice(start + block.length);
    const animated = rules(outside)
      .filter((r) => /(^|[;\s])animation(-name)?\s*:/.test(r.body) && !/animation(-name)?\s*:\s*none/.test(r.body))
      .flatMap((r) => r.selectors);
    expect(animated.length).toBeGreaterThan(0);
    for (const selector of animated) expect(off, `${selector} keeps animating under reduced motion`).toContain(selector);
  });
});
