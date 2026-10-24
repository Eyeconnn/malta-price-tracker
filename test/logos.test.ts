// Shop logos (src/pipeline/logos.ts): which picture of a home page is the logo, and our small copy of it.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOGO_MAX_SIDE, isChallengePage, looksLikeLogo, makeLogoCopy, pickLogoCandidates, sanitizeSvg } from '../src/pipeline/logos.js';

const page = (name: string) => readFile(path.resolve('test/fixtures/logos', name), 'utf8');

describe('pickLogoCandidates', () => {
  it('puts a header image named logo first, then the JSON-LD logo, the touch icon and og:image last', async () => {
    const { candidates } = pickLogoCandidates(await page('header-img.html'), 'https://www.gadget.example.mt/');
    expect(candidates).toEqual([
      // relative to the page's <base href>; the promo banner outside the header and the flag are not the logo
      { source: 'header', url: 'https://www.gadget.example.mt/en/media/gadget.svg' },
      { source: 'json-ld', url: 'https://www.gadget.example.mt/media/org-logo.png' },
      { source: 'icon', url: 'https://www.gadget.example.mt/apple-touch-icon.png' },
      { source: 'og:image', url: 'https://www.gadget.example.mt/media/banner.jpg', mustLookLikeLogo: true },
    ]);
  });

  it('finds a lazy-loaded logo in the home link by the link id', async () => {
    const { candidates } = pickLogoCandidates(await page('lazy-header.html'), 'https://lazy.example.mt/');
    expect(candidates[0]).toEqual({ source: 'header', url: 'https://lazy.example.mt/img/brand.png' });
  });

  it('reads the Organization logo from a JSON-LD graph (through its @id), never a brand logo, and skips bad JSON', async () => {
    const { candidates, notes } = pickLogoCandidates(await page('jsonld.html'), 'https://toybox.example.mt/');
    expect(candidates).toEqual([{ source: 'json-ld', url: 'https://toybox.example.mt/wp-content/uploads/toybox.png' }]);
    expect(notes.join(' ')).toMatch(/og:image is 1200x630, not logo-like/);
  });

  it('takes icons of at least 96 px, largest first, and skips small favicons', async () => {
    const { candidates } = pickLogoCandidates(await page('icons.html'), 'https://icons.example.mt/');
    expect(candidates).toEqual([
      { source: 'icon', url: 'https://icons.example.mt/icon-192.png' },
      { source: 'icon', url: 'https://icons.example.mt/apple-touch-icon.png' },
    ]);
  });

  it('rejects an og:image that is a wide banner, so a page with nothing else has no candidate', async () => {
    const { candidates, notes } = pickLogoCandidates(await page('og-banner.html'), 'https://banner.example.mt/');
    expect(candidates).toEqual([]);
    expect(notes).toContain('og:image is 1200x630, not logo-like');
  });

  it('keeps a small square og:image as the last resort, still checked once fetched', async () => {
    const { candidates } = pickLogoCandidates(await page('og-square.html'), 'https://square.example.mt/');
    expect(candidates).toEqual([{ source: 'og:image', url: 'https://square.example.mt/uploads/square.png', mustLookLikeLogo: true }]);
  });

  it('never offers a non-http address', () => {
    const html = `<header><img class="logo" src="javascript:alert(1)"></header><link rel="apple-touch-icon" href="file:///etc/passwd">`;
    expect(pickLogoCandidates(html, 'https://x.example.mt/').candidates).toEqual([]);
  });

  it('recognises a bot check page', async () => {
    expect(isChallengePage(await page('challenge.html'))).toBe(true);
    expect(isChallengePage(await page('header-img.html'))).toBe(false);
  });
});

describe('looksLikeLogo', () => {
  it('is square-ish and small', () => {
    expect(looksLikeLogo(400, 400)).toBe(true);
    expect(looksLikeLogo(300, 240)).toBe(true);
    expect(looksLikeLogo(1200, 630)).toBe(false);
    expect(looksLikeLogo(1200, 1200)).toBe(false);
  });
});

describe('sanitizeSvg', () => {
  it('removes scripts, event handlers, external references and the doctype', () => {
    const svg = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">
<script>alert(2)</script><foreignObject><div>x</div></foreignObject>
<style>@import url(https://evil.example/x.css); rect { fill: url(https://evil.example/p.svg#p) }</style>
<image xlink:href="https://evil.example/a.png" width="10" height="10"/><use href="#ok"/><image href='file:///c:/x.png'/>
<rect fill="url(#grad)" width="5" height="5"/></svg>`;
    const out = sanitizeSvg(svg);
    expect(out).not.toMatch(/script|onload|foreignObject|DOCTYPE|ENTITY|evil\.example|file:|@import/i);
    expect(out).toContain('href="#ok"');
    expect(out).toContain('url(#grad)');
  });
});

describe('makeLogoCopy', () => {
  let hits = 0;
  let base = '';
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'image/png' }).end();
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('rasterises an SVG logo to a transparent WebP of at most 128 px and never loads its external images', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 40 20">
      <image xlink:href="${base}/a.png" width="40" height="20"/><image href="${base}/b.png" width="40" height="20"/>
      <rect x="5" y="5" width="10" height="10" fill="#c00"/></svg>`;
    const copy = await makeLogoCopy(Buffer.from(svg));
    expect(hits).toBe(0);
    const meta = await sharp(copy.body).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width!, meta.height!)).toBe(LOGO_MAX_SIDE);
    expect(meta.hasAlpha).toBe(true);
    expect([copy.width, copy.height]).toEqual([128, 64]);
    // the corner stays transparent
    const { data, info } = await sharp(copy.body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[info.channels - 1]).toBe(0);
  });

  it('rasterises the SVG fixture that carries a script', async () => {
    const copy = await makeLogoCopy(await readFile(path.resolve('test/fixtures/images/logo.svg')));
    expect([copy.width, copy.height]).toEqual([128, 64]);
  });

  it('shrinks a raster logo to 128 px, keeps its alpha and never enlarges a small one', async () => {
    const big = await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const copy = await makeLogoCopy(big);
    expect([copy.width, copy.height]).toEqual([128, 64]);
    expect((await sharp(copy.body).metadata()).hasAlpha).toBe(true);
    const small = await sharp({ create: { width: 60, height: 60, channels: 3, background: '#fff' } }).png().toBuffer();
    expect((await makeLogoCopy(small)).width).toBe(60);
  });

  it('refuses what is not an image, and a banner when the logo shape is required', async () => {
    await expect(makeLogoCopy(Buffer.from('<html><body>hi</body></html>'))).rejects.toThrow(/not an image/);
    const banner = await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    await expect(makeLogoCopy(banner, { mustLookLikeLogo: true })).rejects.toThrow(/not logo-like/);
    expect((await makeLogoCopy(banner)).width).toBe(128);
  });
});
