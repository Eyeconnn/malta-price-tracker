// Product photos are served from our own small copies in R2 (owner decision 23 Oct): never the shop's original,
// never hot-linked. One copy per original: WebP, at most 480 px on the long side, no metadata, named after the
// sha256 of the original so the same picture is stored once.
import sharp, { type Metadata } from 'sharp';

/** Longest side of a stored copy, in pixels. */
export const MAX_SIDE = 480;
export const WEBP_QUALITY = 75;
/** Originals larger than this are refused (as the fetcher's body limit). */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
/** Decoded size limit, against decompression bombs (a 15 MB file can claim billions of pixels). */
const MAX_INPUT_PIXELS = 50_000_000;
/** R2 free tier: 10 GB of storage. The daily summary warns from 8 GB. */
export const WARN_BYTES = 8e9;

/**
 * Formats we accept as a product photo (sharp's names). Anything else is not an image to us; SVG is refused too
 * (no shop uses it for product photos, and an SVG can carry script).
 */
const FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff']);

export type SmallCopy = { body: Buffer; width: number; height: number; bytes: number; contentType: 'image/webp' };

/** The R2 key of an original's stored copy. */
export const photoKey = (sha256: string) => `img/${sha256}.webp`;

const KEY = /^img\/[0-9a-f]{64}\.webp$/;
/** True only for a key of a small copy (old keys of full-size originals, images/..., are not photos). */
export const isPhotoKey = (key: string | null | undefined): key is string => typeof key === 'string' && KEY.test(key);

/**
 * The stored copy of an original: its first frame, rotated upright, shrunk to fit MAX_SIDE (never enlarged), WebP
 * at quality 75 with all metadata stripped (sharp keeps none unless asked). SVG, other non-images and images
 * over 15 MB or 50 megapixels are refused.
 */
export async function makeSmallCopy(original: Buffer): Promise<SmallCopy> {
  if (original.length > MAX_IMAGE_BYTES) throw new Error('image over 15 MB');
  let meta: Metadata;
  try {
    meta = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (e) {
    throw new Error(/pixel limit/i.test((e as Error).message) ? 'image has too many pixels' : 'not an image');
  }
  if (!meta.format || !FORMATS.has(meta.format) || !meta.width || !meta.height) throw new Error('not an image');
  if (meta.width * (meta.pageHeight ?? meta.height) > MAX_INPUT_PIXELS) throw new Error('image has too many pixels');

  // an animated image keeps its first frame only (sharp reads one page unless asked for more)
  const { data, info } = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 })
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { body: data, width: info.width, height: info.height, bytes: data.length, contentType: 'image/webp' };
}

const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

/**
 * The daily summary's R2 line: photo copies and HTML snapshots, their total against the free tier and the download
 * cap (images.ts PHOTO_STORAGE_CAP_BYTES), with a warning from 8 GB.
 */
export function imageStorageLine(count: number, photoBytes: number, snapshotBytes: number): string {
  const total = photoBytes + snapshotBytes;
  const line =
    `R2 storage: ${count.toLocaleString('en')} photos (${fmtBytes(photoBytes)}) and HTML snapshots (${fmtBytes(snapshotBytes)}), ` +
    `${fmtBytes(total)} of the 10 GB free tier; photo downloads stop at 9 GB.`;
  return total >= WARN_BYTES ? `${line}  WARNING: over 8 GB, the R2 free tier ends at 10 GB (ask the owner before going over)` : line;
}
