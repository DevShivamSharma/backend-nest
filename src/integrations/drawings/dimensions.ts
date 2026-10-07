import type { PlanText } from './plan-source';
import type { RgbImage } from './raster';

/**
 * Dimension lines printed on a plan: a number beside a straight line that ends in ticks,
 * arrows or extension lines. Each one is a measurement the drafter made, which the import can
 * check its own scale against. Found on the plan's pixels, so scans and drawings are read alike.
 */
export interface DimensionLine {
  /** The text as printed, and the number it states (in the drawing's own unit). */
  text: string;
  value: number;
  /** A unit printed with the number, when there is one. */
  unit: 'm' | 'mm' | 'cm' | 'ft' | null;
  /** The measured line's ends, in pixels. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  vertical: boolean;
}

const NUMBER = /^(\d{1,6}(?:[.,]\d{1,3})?)\s*(m|mm|cm|mtrs?|metres?|meters?|ft|')?$/i;
/** A pixel this dark is ink. */
const INK = 170;

export function findDimensionLines(
  img: RgbImage,
  texts: PlanText[],
  /** The stall grid's pitch in pixels, when the plan has one: grid lines are not dimensions. */
  gridPitch: { x: number; y: number } | null = null,
): DimensionLine[] {
  const lum = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 255;
    const k = 3 * (Math.round(y) * img.width + Math.round(x));
    return 0.299 * img.data[k] + 0.587 * img.data[k + 1] + 0.114 * img.data[k + 2];
  };
  const out: DimensionLine[] = [];
  for (const t of texts) {
    // OCR splits "49.45" at its point ("49 45"), and reads the ticks either side as letters
    // ("1 40.00 y"): one number among one-character scraps is that number.
    let raw = t.text
      .trim()
      .replace(/^(\d{1,4}) (\d{2})$/, '$1.$2')
      .replace(/\s+/g, ' ');
    const tokens = raw.split(' ');
    const numbers = tokens.filter((w) => /^\d{1,6}[.,]\d{1,3}$/.test(w));
    if (numbers.length === 1 && tokens.every((w) => w === numbers[0] || w.length <= 1)) {
      raw = numbers[0];
    }
    const m = NUMBER.exec(raw);
    if (!m) continue;
    const value = Number(m[1].replace(',', '.'));
    if (!(value > 0)) continue;
    // A bare whole number under 1000 is a stall or room number far more often than a
    // dimension; dimensions print decimals ("49.45"), a unit, or millimetres ("4500").
    if (!m[2] && !/[.,]/.test(m[1]) && value < 1000) continue;
    const unitWord = (m[2] ?? '').toLowerCase();
    const unit: DimensionLine['unit'] = !unitWord
      ? null
      : unitWord === 'mm'
        ? 'mm'
        : unitWord === 'cm'
          ? 'cm'
          : unitWord === 'ft' || unitWord === "'"
            ? 'ft'
            : 'm';
    const vertical = t.height > 1.8 * t.width && t.text.trim().length > 1;
    // Work in the text's own frame: `along` runs with the text, `across` away from it.
    const size = vertical ? t.width : t.height;
    const centreAlong = vertical ? t.y + t.height / 2 : t.x + t.width / 2;
    const lowAcross = vertical ? t.x : t.y;
    const highAcross = vertical ? t.x + t.width : t.y + t.height;
    const ink = (along: number, across: number) =>
      vertical ? lum(across, along) < INK : lum(along, across) < INK;
    const length = vertical ? img.height : img.width;

    let found: DimensionLine | null = null;
    // The line runs just beside the number: below or above it (or left, right when vertical).
    const offsets: number[] = [];
    for (let d = 1; d <= Math.ceil(1.3 * size); d++) offsets.push(highAcross + d, lowAcross - d);
    for (const across of offsets) {
      if (!ink(centreAlong, across) && !ink(centreAlong, across + 1)) continue;
      // Follow the line both ways, bridging gaps of up to two pixels.
      const follow = (dir: 1 | -1) => {
        let pos = centreAlong;
        let gap = 0;
        let end = centreAlong;
        while (pos > 0 && pos < length - 1 && gap <= 2) {
          pos += dir;
          if (ink(pos, across) || ink(pos, across + 1) || ink(pos, across - 1)) {
            gap = 0;
            end = pos;
          } else {
            gap++;
          }
        }
        return end;
      };
      const start = follow(-1);
      void start;
      const end = follow(1);
      if (end - start < Math.max(4, 0.3 * size)) continue;
      // A straight line, not the edge of a filled shape: clear on both sides somewhere along it.
      let clear = 0;
      for (let p = start; p <= end; p += Math.max(1, Math.floor((end - start) / 20))) {
        if (!ink(p, across - 3) && !ink(p, across + 3)) clear++;
      }
      if (clear < 5) continue;
      // Ticks and extension lines cross the line: they end the measured stretch.
      const crossings: number[] = [];
      let run: [number, number] | null = null;
      // Look a little past both ends: a tick at the very end must be seen whole.
      for (let p = start - 5; p <= end + 6; p++) {
        let above = false;
        let below = false;
        for (let w = -4; w <= 4 && !(above && below) && p <= end + 5; w++) {
          if (ink(p + w, across - 3) || ink(p + w, across - 4)) above = true;
          if (ink(p + w, across + 3) || ink(p + w, across + 4)) below = true;
        }
        if (above && below) {
          run = run ? [run[0], p] : [p, p];
        } else if (run) {
          // A tick or extension line crosses at the middle of the stretch where it is seen.
          crossings.push(Math.round((run[0] + run[1]) / 2));
          run = null;
        }
      }
      // A grid line crosses the other grid lines at the grid's pitch, again and again.
      const pitch = gridPitch ? (vertical ? gridPitch.y : gridPitch.x) : 0;
      if (pitch) {
        let regular = 0;
        for (let i = 1; i < crossings.length; i++) {
          const step = crossings[i] - crossings[i - 1];
          const cells = Math.round(step / pitch);
          regular = cells >= 1 && Math.abs(step - cells * pitch) <= 0.12 * pitch ? regular + 1 : 0;
          if (regular >= 3) break;
        }
        if (regular >= 3) continue;
      }
      const left = [...crossings].reverse().find((p) => p <= centreAlong);
      const right = crossings.find((p) => p >= centreAlong);
      if (left === undefined || right === undefined || right - left < 3) continue;
      found = vertical
        ? { text: t.text, value, unit, x1: across, y1: left, x2: across, y2: right, vertical }
        : { text: t.text, value, unit, x1: left, y1: across, x2: right, y2: across, vertical };
      break;
    }
    if (found) out.push(found);
  }
  return out;
}

/** Length of a dimension line in pixels. */
export function dimensionPixels(d: DimensionLine): number {
  return Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
}
