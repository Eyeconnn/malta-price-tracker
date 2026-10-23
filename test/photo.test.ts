// Small stored copies of product photos (src/pipeline/photo.ts): WebP, at most 480 px on the long side, no metadata.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, imageStorageLine, isPhotoKey, makeSmallCopy, photoKey } from '../src/pipeline/photo.js';

const fixture = (name: string) => readFile(path.resolve('test/fixtures/images', name));

describe('makeSmallCopy', () => {
  it('resizes a PNG to 480 px on the long side as WebP without metadata', async () => {
    const png = await fixture('photo-800x600.png');
    expect((await sharp(png).metadata()).exif).toBeDefined();
    const copy = await makeSmallCopy(png);
    expect(copy.contentType).toBe('image/webp');
    expect([copy.width, copy.height]).toEqual([480, 360]);
    expect(copy.bytes).toBe(copy.body.length);
    const meta = await sharp(copy.body).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([480, 360]);
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(copy.body.includes(Buffer.from('fixture-secret-exif'))).toBe(false);
  });

  it('never enlarges a small raster image', async () => {
    const small = await sharp(await fixture('photo-800x600.png')).resize(120, 90).png().toBuffer();
    const copy = await makeSmallCopy(small);
    expect([copy.width, copy.height]).toEqual([120, 90]);
  });

  it('keeps a portrait image within 480 px high', async () => {
    const tall = await sharp(await fixture('photo-800x600.png')).rotate(90).png().toBuffer();
    const copy = await makeSmallCopy(tall);
    expect([copy.width, copy.height]).toEqual([360, 480]);
  });

  it('rasterises an SVG to WebP (no SVG and no script is ever stored)', async () => {
    const svg = await fixture('logo.svg');
    const copy = await makeSmallCopy(svg);
    const meta = await sharp(copy.body).metadata();
    expect(meta.format).toBe('webp');
    // a vector is drawn at the full 480 px, not scaled up from its 200 px raster
    expect([copy.width, copy.height]).toEqual([480, 240]);
    expect(copy.body.includes(Buffer.from('<script'))).toBe(false);
    expect(copy.body.includes(Buffer.from('<svg'))).toBe(false);
  });

  it('rejects data that is not an image', async () => {
    await expect(makeSmallCopy(Buffer.from('<html><body>not a picture</body></html>'))).rejects.toThrow(/not an image/);
  });

  it('rejects images over 15 MB', async () => {
    const big = Buffer.concat([await fixture('photo-800x600.png'), Buffer.alloc(MAX_IMAGE_BYTES)]);
    await expect(makeSmallCopy(big)).rejects.toThrow(/over 15 MB/);
  });
});

describe('photo keys', () => {
  const sha = 'a'.repeat(64);
  it('names the stored copy after the original sha256', () => {
    expect(photoKey(sha)).toBe(`img/${sha}.webp`);
    expect(isPhotoKey(photoKey(sha))).toBe(true);
  });
  it('accepts only img/<64 lowercase hex>.webp', () => {
    for (const k of [`images/${sha}.jpg`, `img/${sha}.png`, `img/${sha.slice(1)}.webp`, `img/${'A'.repeat(64)}.webp`, `img/../${sha}.webp`, null, '']) {
      expect(isPhotoKey(k), String(k)).toBe(false);
    }
  });
});

describe('imageStorageLine', () => {
  it('reports the stored copies and their size against the free tier', () => {
    expect(imageStorageLine(1234, 46_000_000)).toBe('Photos stored in R2: 1,234 (46 MB of 10 GB free tier).');
  });
  it('warns from 8 GB', () => {
    expect(imageStorageLine(200_000, 8_100_000_000)).toMatch(/^Photos stored in R2: 200,000 \(8\.1 GB of 10 GB free tier\)\. {2}WARNING: over 8 GB/);
    expect(imageStorageLine(10, 7_900_000_000)).not.toMatch(/WARNING/);
  });
});
