import type { PlanText } from './plan-source';
import type { RgbImage } from './raster';

/**
 * Plans are scanned or exported slightly turned. The grid and walls are straight lines, so the
 * angle at which the drawing's dark pixels line up best in rows and columns is the turn; the
 * sheet is turned back by it before the grid is read.
 */

/** Turns smaller than this are left alone: they move a 100 m hall by under 3 cm. */
const MIN_ANGLE = 0.015;
const MAX_ANGLE = 15;

export interface Skew {
  /** Degrees the drawing is turned, clockwise as seen on the sheet. */
  degrees: number;
  /** How much sharper the rows and columns are at that angle than unturned (1 = no gain). */
  gain: number;
}

export function estimateSkew(img: RgbImage): Skew {
  const step = Math.max(1, Math.ceil(Math.max(img.width, img.height) / 1200));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const k = 3 * (y * img.width + x);
      const lum = 0.299 * img.data[k] + 0.587 * img.data[k + 1] + 0.114 * img.data[k + 2];
      if (lum < 215) {
        xs.push(x / step);
        ys.push(y / step);
      }
    }
  }
  if (xs.length < 500) return { degrees: 0, gain: 1 };
  // A sample is enough to find the angle.
  const every = Math.max(1, Math.floor(xs.length / 150_000));
  const size = Math.ceil(Math.hypot(img.width, img.height) / step) + 2;
  const rowsHist = new Float64Array(2 * size);
  const colsHist = new Float64Array(2 * size);
  const sharpness = (degrees: number) => {
    const a = (degrees * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    rowsHist.fill(0);
    colsHist.fill(0);
    for (let i = 0; i < xs.length; i += every) {
      // Undo a clockwise turn of `degrees` (y points down).
      const u = xs[i] * c + ys[i] * s;
      const v = -xs[i] * s + ys[i] * c;
      colsHist[Math.round(u) + size]++;
      rowsHist[Math.round(v) + size]++;
    }
    let total = 0;
    for (let i = 0; i < rowsHist.length; i++) total += rowsHist[i] ** 2 + colsHist[i] ** 2;
    return total;
  };
  const flat = sharpness(0);
  let best = 0;
  let bestScore = flat;
  for (let d = -MAX_ANGLE; d <= MAX_ANGLE; d += 0.5) {
    const score = sharpness(d);
    if (score > bestScore) [best, bestScore] = [d, score];
  }
  for (const span of [0.5, 0.1]) {
    const centre = best;
    for (let d = centre - span; d <= centre + span; d += span / 10) {
      const score = sharpness(d);
      if (score > bestScore) [best, bestScore] = [d, score];
    }
  }
  const gain = bestScore / flat;
  if (Math.abs(best) < MIN_ANGLE || gain < 1.02) return { degrees: 0, gain: 1 };
  return { degrees: Math.round(best * 1000) / 1000, gain };
}

/**
 * Turns an image back by `degrees` (anticlockwise) on a white ground, and moves texts with it.
 * The canvas grows to hold the whole turned sheet.
 */
export async function unturn(
  img: RgbImage,
  texts: PlanText[],
  degrees: number,
): Promise<{ image: RgbImage; texts: PlanText[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharp = require('sharp') as typeof import('sharp').default;
  const { data, info } = await sharp(
    Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
    { raw: { width: img.width, height: img.height, channels: 3 } },
  )
    .rotate(-degrees, { background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const a = (-degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const move = (x: number, y: number): [number, number] => {
    const dx = x - img.width / 2;
    const dy = y - img.height / 2;
    // sharp turns clockwise for positive angles, with y pointing down.
    return [dx * c - dy * s + info.width / 2, dx * s + dy * c + info.height / 2];
  };
  const moved = texts.map((t) => {
    const [cx, cy] = move(t.x + t.width / 2, t.y + t.height / 2);
    return { ...t, x: cx - t.width / 2, y: cy - t.height / 2 };
  });
  return {
    image: { width: info.width, height: info.height, data: new Uint8Array(data) },
    texts: moved,
  };
}
