// Product photos are served from our own small copies in R2 (owner decision 23 Oct): never the shop's original,
// never hot-linked. One copy per original: WebP, at most 480 px on the long side, no metadata, named after the
// sha256 of the original so the same picture is stored once.
import sharp from 'sharp';

/** Longest side of a stored copy, in pixels. */
export const MAX_SIDE = 480;
export const WEBP_QUALITY = 75;
/** Originals larger than this are refused (as the fetcher's body limit). */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
/** Decoded size limit, against decompression bombs (a 15 MB file can claim billions of pixels). */
const MAX_INPUT_PIXELS = 50_000_000;
/** R2 free tier: 10 GB of storage. The daily summary warns from 8 GB. */
export const WARN_BYTES = 8e9;

/** Formats we accept as a product photo (sharp's names). Anything else is not an image to us. */
const FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff', 'svg']);

export type SmallCopy = { body: Buffer; width: number; height: number; bytes: number; contentType: 'image/webp' };

/** The R2 key of an original's stored copy. */
export const photoKey = (sha256: string) => `img/${sha256}.webp`;

const KEY = /^img\/[0-9a-f]{64}\.webp$/;
/** True only for a key of a small copy (old keys of full-size originals, images/..., are not photos). */
export const isPhotoKey = (key: string | null | undefined): key is string => typeof key === 'string' && KEY.test(key);

/**
 * The stored copy of an original: rotated upright, shrunk to fit MAX_SIDE (never enlarged; an SVG is drawn at
 * MAX_SIDE instead), WebP at quality 75 with all metadata stripped (sharp keeps none unless asked). An SVG is
 * rasterised, so no SVG (and no script inside one) is ever stored or served.
 */
export async function makeSmallCopy(original: Buffer): Promise<SmallCopy> {
  if (original.length > MAX_IMAGE_BYTES) throw new Error('image over 15 MB');
  let meta: sharp.Metadata;
  try {
    meta = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new Error('not an image');
  }
  if (!meta.format || !FORMATS.has(meta.format) || !meta.width || !meta.height) throw new Error('not an image');

  const vector = meta.format === 'svg';
  const long = Math.max(meta.width, meta.height);
  // an SVG is drawn at the density that makes its long side MAX_SIDE (72 dpi is its natural size)
  const input = vector
    ? sharp(original, { density: Math.min(2400, Math.max(1, (72 * MAX_SIDE) / long)), limitInputPixels: MAX_INPUT_PIXELS })
    : sharp(original, { limitInputPixels: MAX_INPUT_PIXELS });
  const { data, info } = await input
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: !vector })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { body: data, width: info.width, height: info.height, bytes: data.length, contentType: 'image/webp' };
}

const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

/** The daily summary's storage line for the stored copies, with a warning from 8 GB. */
export function imageStorageLine(count: number, bytes: number): string {
  const line = `Photos stored in R2: ${count.toLocaleString('en')} (${fmtBytes(bytes)} of 10 GB free tier).`;
  return bytes >= WARN_BYTES ? `${line}  WARNING: over 8 GB, the R2 free tier ends at 10 GB (ask the owner before going over)` : line;
}
