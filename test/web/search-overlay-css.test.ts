// Static guards for the search overlay's styles (web/src/styles.css, SearchOverlay.tsx).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('../../web/src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');

describe('search overlay styles', () => {
  it('animates about 200 ms in and 160 ms out', () => {
    expect(css).toMatch(/\.search-overlay-animated\[data-state="open"\]\s*\{[^}]*animation:[^;}]*\b200ms/);
    expect(css).toMatch(/\.search-overlay-animated\[data-state="closed"\]\s*\{[^}]*animation:[^;}]*\b160ms/);
  });

  it('switches both animations off under prefers-reduced-motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.search-overlay-animated[data-state="open"]');
    expect(reduced).toContain('.search-overlay-animated[data-state="closed"]');
  });

  it('the component uses tokens only and has no em dash', () => {
    const source = read('../../web/src/components/site/SearchOverlay.tsx');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|bg-black|bg-white|text-black|text-white/);
    expect(source).not.toContain(String.fromCharCode(0x2014));
  });
});
