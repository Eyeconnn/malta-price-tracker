// In this theme `accent` is shadcn's pale hover fill (--fill), not the blue design accent, which is `brand`.
// Text or borders in `accent` render almost invisible, so site code must use `brand` instead.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve('web/src');
const UI = path.join(ROOT, 'components', 'ui');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return p === UI ? [] : files(p);
    return /\.(tsx|ts)$/.test(name) ? [p] : [];
  });
}

describe('accent colour classes', () => {
  it('site code never uses the pale accent fill for text, borders or rings', () => {
    const bad = /\b(text|border|ring|outline|decoration|stroke|fill)-accent(\/\d+)?\b(?!-)/;
    const hits = files(ROOT).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => (bad.test(line) ? `${path.relative(ROOT, f)}:${i + 1}` : null))
        .filter((x): x is string => x !== null),
    );
    expect(hits).toEqual([]);
  });
});
