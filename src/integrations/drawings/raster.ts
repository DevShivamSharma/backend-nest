/**
 * A plan as pixels: the common input of the grid analysis. Scanned PDFs and images are pixels
 * already; vector drawings are drawn into one (see `drawPrimitives`).
 */
export interface RgbImage {
  width: number;
  height: number;
  /** Packed RGB, 3 bytes per pixel, rows top to bottom. */
  data: Uint8Array;
}

/** Largest image accepted, in pixels: a 9000 x 6000 scan, about 160 MB as RGB. */
export const MAX_PIXELS = 54_000_000;

export class DrawingReadError extends Error {}

/** Decodes a PNG, JPEG, WebP or TIFF file. */
export async function decodeImage(data: Uint8Array): Promise<RgbImage> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharp = require('sharp') as typeof import('sharp').default;
  try {
    const image = sharp(data, { limitInputPixels: MAX_PIXELS }).rotate();
    const { data: pixels, info } = await image
      .flatten({ background: '#ffffff' })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8Array(pixels) };
  } catch (error) {
    throw new DrawingReadError(
      `The image could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Grey level of pixel `i` (0 black .. 255 white). */
export function luminance(img: RgbImage, i: number): number {
  const d = img.data;
  return 0.299 * d[3 * i] + 0.587 * d[3 * i + 1] + 0.114 * d[3 * i + 2];
}

/** Encodes as JPEG, for previews: a plan picture is a fraction of its PNG size. */
export async function encodePreview(img: RgbImage, maxSide = 0): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharp = require('sharp') as typeof import('sharp').default;
  let pipeline = sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 3 },
  });
  if (maxSide && Math.max(img.width, img.height) > maxSide) {
    pipeline = pipeline.resize({ width: maxSide, height: maxSide, fit: 'inside' });
  }
  return pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
}

/** One straight stroke of a vector drawing, in pixels of the target image. */
export interface PixelSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: [number, number, number];
}

/** One filled polygon of a vector drawing, in pixels. */
export interface PixelFill {
  points: number[];
  color: [number, number, number];
}

/**
 * Draws vector strokes (1 px wide, so a grid line stays a thin line) and fills onto a white
 * image. Fills are drawn first so lines stay visible on top of them, as on the printed plan.
 */
export function drawPrimitives(
  width: number,
  height: number,
  fills: Iterable<PixelFill>,
  segments: Iterable<PixelSegment>,
): RgbImage {
  if (width * height > MAX_PIXELS) {
    throw new DrawingReadError('The drawing is too large to read at this scale.');
  }
  const data = new Uint8Array(width * height * 3).fill(255);
  const put = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const k = 3 * (y * width + x);
    data[k] = c[0];
    data[k + 1] = c[1];
    data[k + 2] = c[2];
  };
  for (const fill of fills)
    fillPolygon(fill.points, width, height, (x, y) => put(x, y, fill.color));
  for (const s of segments) {
    const steps = Math.ceil(Math.max(Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1)));
    for (let t = 0; t <= steps; t++) {
      const f = steps ? t / steps : 0;
      put(Math.floor(s.x1 + (s.x2 - s.x1) * f), Math.floor(s.y1 + (s.y2 - s.y1) * f), s.color);
    }
  }
  return { width, height, data };
}

/** Even-odd scanline fill of one polygon (flat x, y). */
function fillPolygon(
  points: number[],
  width: number,
  height: number,
  put: (x: number, y: number) => void,
): void {
  const n = points.length / 2;
  if (n < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < points.length; i += 2) {
    minY = Math.min(minY, points[i]);
    maxY = Math.max(maxY, points[i]);
  }
  const y0 = Math.max(0, Math.ceil(minY - 0.5));
  const y1 = Math.min(height - 1, Math.floor(maxY - 0.5));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const ax = points[2 * i];
      const ay = points[2 * i + 1];
      const bx = points[(2 * i + 2) % points.length];
      const by = points[(2 * i + 3) % points.length];
      if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) {
        xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = from; x <= to; x++) put(x, y);
    }
  }
}
