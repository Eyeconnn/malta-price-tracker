// Shop logos (src/pipeline/logos.ts): which picture of a home page is the logo, and our small copy of it.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import sharp from 'sharp';
import { crc32 } from 'node:zlib';
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
      { source: 'og:image', url: 'https://www.gadget.example.mt/media/banner.jpg' },
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
    expect(candidates).toEqual([{ source: 'og:image', url: 'https://square.example.mt/uploads/square.png' }]);
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

  it('drops every data: href, so no embedded picture is decoded', () => {
    const out = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgo=" width="4" height="4"/><rect fill="url('data:image/png;base64,AAAA')"/></svg>`);
    expect(out).not.toMatch(/data:/);
    expect(out).toMatch(/^<svg/);
  });

  it('drops hrefs under any prefix bound to xlink, and scripts under any namespace prefix', () => {
    const svg = `<s:svg xmlns:s="http://www.w3.org/2000/svg" xmlns:q="http://www.w3.org/1999/xlink">
      <s:image q:href="https://evil.example/q.png" width="9" height="9"/><s:use q:href="#keep"/>
      <s:script>alert(1)</s:script><h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(2)</h:script>
      <s:rect s:onclick="alert(3)" width="4" height="4"/></s:svg>`;
    const out = sanitizeSvg(svg);
    expect(out).not.toMatch(/evil\.example|script|alert|onclick/i);
    expect(out).toContain('q:href="#keep"');
  });

  it('gives nothing for a document that is not an SVG', () => {
    expect(sanitizeSvg('<html><body><svg></svg></body></html>')).toBe('');
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

  it('refuses what is not an image, and an og:image banner', async () => {
    await expect(makeLogoCopy(Buffer.from('<html><body>hi</body></html>'))).rejects.toThrow(/not an image/);
    const banner = await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    await expect(makeLogoCopy(banner, { source: 'og:image' })).rejects.toThrow(/not logo-like/);
    // the same picture in the header is a wide logo: stored at most 256 x 64
    const header = await makeLogoCopy(banner, { source: 'header' });
    expect([header.width, header.height]).toEqual([123, 64]);
  });

  const png = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();

  it('checks the decoded size of every source: no 1x1, a long side of at least 48 px', async () => {
    for (const source of ['header', 'json-ld', 'icon', 'og:image'] as const) {
      await expect(makeLogoCopy(await png(1, 1), { source }), source).rejects.toThrow(/1x1/);
      await expect(makeLogoCopy(await png(40, 30), { source }), source).rejects.toThrow(/40x30, too small/);
    }
    expect((await makeLogoCopy(await png(48, 48), { source: 'header' })).width).toBe(48);
  });

  it('keeps header and JSON-LD wordmarks up to 10:1 wide (at least 120 px wide past 4:1), and up to 1:4 tall', async () => {
    for (const [w, h] of [
      [600, 88],
      [2000, 258],
      [352, 50],
      [306, 60],
    ]) {
      expect((await makeLogoCopy(await png(w!, h!), { source: 'header' })).width, `${w}x${h}`).toBe(256);
    }
    expect((await makeLogoCopy(await png(1191, 285), { source: 'json-ld' })).width).toBe(256);
    await expect(makeLogoCopy(await png(1100, 100), { source: 'header' })).rejects.toThrow(/1100x100, wider than 10:1/);
    // Solaris and Squaredeal (about 8.6:1) are real wordmarks and fit under 10:1
    expect((await makeLogoCopy(await png(2221, 258), { source: 'header' })).width).toBe(256);
    expect((await makeLogoCopy(await png(460, 53), { source: 'header' })).width).toBe(256);
    await expect(makeLogoCopy(await png(100, 19), { source: 'json-ld' })).rejects.toThrow(/100x19, a wordmark under 120 px wide/);
    await expect(makeLogoCopy(await png(60, 300), { source: 'json-ld' })).rejects.toThrow(/60x300, taller than 1:4/);
  });

  it('stores a wide logo at most 256 px wide and 64 px tall, a square-ish one at most 128 px', async () => {
    const wide = await makeLogoCopy(await png(2000, 258), { source: 'header' });
    expect([wide.width, wide.height]).toEqual([256, 33]);
    const two = await makeLogoCopy(await png(600, 300), { source: 'header' });
    expect([two.width, two.height]).toEqual([128, 64]);
    const square = await makeLogoCopy(await png(512, 400), { source: 'header' });
    expect([square.width, square.height]).toEqual([128, 100]);
  });

  it('keeps icons square-ish', async () => {
    await expect(makeLogoCopy(await png(200, 100), { source: 'icon' })).rejects.toThrow(/icon is 200x100, not square-ish/);
  });

  it('takes an icon only when its real pixels are at least 96 px, whatever its link declared', async () => {
    await expect(makeLogoCopy(await png(32, 32), { source: 'icon' })).rejects.toThrow(/icon is 32x32, too small \(under 96 px\)/);
    await expect(makeLogoCopy(await png(180, 60), { source: 'icon' })).rejects.toThrow(/icon is 180x60, too small \(under 96 px\)/);
    expect((await makeLogoCopy(await png(180, 180), { source: 'icon' })).width).toBe(128);
  });

  it('an SVG scales, so only its shape is checked', async () => {
    const svg = (w: number, h: number) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}"/></svg>`);
    expect((await makeLogoCopy(svg(24, 24), { source: 'icon' })).width).toBe(128);
    expect((await makeLogoCopy(svg(50, 10), { source: 'header' })).width).toBe(256);
    await expect(makeLogoCopy(svg(110, 10), { source: 'header' })).rejects.toThrow(/wider than 10:1/);
  });

  it('never decodes a picture embedded in an SVG (a data: bomb is dropped first)', async () => {
    // a PNG whose header claims 60000 x 60000 pixels
    const tiny = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).png().toBuffer();
    const bomb = Buffer.from(tiny);
    bomb.writeUInt32BE(60000, 16);
    bomb.writeUInt32BE(60000, 20);
    bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 40 20">
      <image xlink:href="data:image/png;base64,${bomb.toString('base64')}" width="40" height="20"/><rect width="10" height="10" fill="#c00"/></svg>`;
    const started = Date.now();
    const copy = await makeLogoCopy(Buffer.from(svg), { source: 'header' });
    expect([copy.width, copy.height]).toEqual([128, 64]);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
