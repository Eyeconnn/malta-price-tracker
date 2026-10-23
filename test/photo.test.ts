// Small stored copies of product photos (src/pipeline/photo.ts): WebP, at most 480 px on the long side, no metadata.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, imageStorageLine, isPhotoKey, makeSmallCopy, photoKey } from '../src/pipeline/photo.js';

const fixture = (name: string) => readFile(path.resolve('test/fixtures/images', name));

/** A PNG whose header claims width x height (the pixel data stays tiny): what a decompression bomb looks like. */
async function claimSize(png: Buffer, width: number, height: number): Promise<Buffer> {
  const out = Buffer.from(png);
  // signature (8), IHDR length (4), 'IHDR' (4), then width and height; the CRC covers type + data (17 bytes)
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt32BE(crc32(out.subarray(12, 29)), 29);
  return out;
}

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

  it('refuses SVG (no SVG is ever stored or served)', async () => {
    await expect(makeSmallCopy(await fixture('logo.svg'))).rejects.toThrow(/not an image/);
  });

  it('keeps only the first frame of an animated image', async () => {
    const gif = await fixture('two-frames.gif');
    expect((await sharp(gif).metadata()).pages).toBe(2);
    const copy = await makeSmallCopy(gif);
    const meta = await sharp(copy.body).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.pages ?? 1).toBe(1);
    expect([copy.width, copy.height]).toEqual([40, 40]);
    // the first frame is red
    const { data } = await sharp(copy.body).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(150);
    expect(data[2]).toBeLessThan(80);
  });

  it('refuses an image whose pixel count is over the limit (decompression bomb)', async () => {
    const bomb = await claimSize(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer(), 10_000, 10_000);
    expect(bomb.length).toBeLessThan(1000);
    await expect(makeSmallCopy(bomb)).rejects.toThrow(/too many pixels/);
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
  it('reports the stored copies and the snapshots against the free tier and the download cap', () => {
    expect(imageStorageLine(1234, 46_000_000, 12_000_000)).toBe(
      'R2 storage: 1,234 photos (46 MB) and HTML snapshots (12 MB), 58 MB of the 10 GB free tier; photo downloads stop at 9 GB.',
    );
  });
  it('warns from 8 GB, photos and snapshots together', () => {
    expect(imageStorageLine(200_000, 6_100_000_000, 2_000_000_000)).toMatch(/, 8\.1 GB of the 10 GB free tier; .*\. {2}WARNING: over 8 GB/);
    expect(imageStorageLine(10, 7_900_000_000, 0)).not.toMatch(/WARNING/);
  });
});
