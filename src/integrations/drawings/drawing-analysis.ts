import { join } from 'node:path';

import { estimateSkew, unturn } from './deskew';
import { DimensionLine, findDimensionLines } from './dimensions';
import {
  analyseGrid,
  ColorFamily,
  colorFamily,
  NoGridError,
  OverlayGroup,
  PlanMap,
} from './grid-map';
import { analyseOutlines } from './outline-map';
import { PlanFormat, PlanSource, PlanText, readPlanPages } from './plan-source';
import { DrawingReadError, encodePreview, RgbImage } from './raster';
import { MeasuredDimension, statedGridSize } from './scale';

/**
 * Everything the import needs from a plan file, per page, as plain data so it crosses a worker
 * thread boundary unchanged. Positions are in map units (grid cells, or blocks of pixels when
 * the plan has no grid) from the page map's top-left corner. Metres come later, from the scale
 * evidence gathered here and the person's calibration.
 */
export interface DrawingAnalysisInput {
  data: Uint8Array;
  fileName: string;
  /** Read the words of scanned pages by OCR (vector pages carry their texts). */
  readScannedText: boolean;
}

/** A text of the plan, in map units. */
export interface AnalysedText {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where it came from: the file itself, or OCR of a scan (less certain). */
  source: 'file' | 'ocr';
  /** OCR confidence 0-100; 100 for texts the file holds. */
  confidence: number;
  /** A colour swatch just left of the text, as legend rows have. */
  swatch: { family: ColorFamily; color: string } | null;
}

/** A dimension line in map units. */
export interface AnalysedDimension extends MeasuredDimension {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  vertical: boolean;
}

export interface SheetAnalysis {
  page: number;
  format: PlanFormat;
  /** Degrees the page was turned back to square its grid (0 when it was square). */
  rotation: number;
  warnings: string[];
  map: Omit<PlanMap, 'cells' | 'regionOf' | 'warnings' | 'originX' | 'originY'> & {
    /** Int16 cells, base64: -2 outside, -1 floor, >= 0 overlay group. */
    cells: string;
    /** Uint8 grid of each cell, base64 (see `PlanMap.regionOf`). */
    regionOf: string;
  };
  /** The page as a picture, aligned with the map: for the review screen. */
  preview: {
    jpeg: string;
    width: number;
    height: number;
    /** The picture pixel at the map's (0, 0), and picture pixels per map unit. */
    originX: number;
    originY: number;
    unitPxX: number;
    unitPxY: number;
  };
  texts: AnalysedText[];
  dimensions: AnalysedDimension[];
  /** A grid size printed on the plan ("Grid size is 1m x 1m"). */
  statedGrid: { metres: number; text: string } | null;
  /** Metres per map unit, when the file itself states its units or scale. */
  fileScale: { metresPerUnit: number; detail: string } | null;
}

export interface DrawingAnalysis {
  fileName: string;
  sheets: SheetAnalysis[];
  /** Pages that could not be read, and why. */
  skipped: Array<{ page: number; reason: string }>;
}

export type DrawingAnalysisOutcome =
  | { ok: true; analysis: DrawingAnalysis }
  | { ok: false; kind: 'unreadable' | 'internal'; message: string };

/** Longest side of the review picture. */
const PREVIEW_SIDE = 2400;

export async function runDrawingAnalysis(
  input: DrawingAnalysisInput,
): Promise<DrawingAnalysisOutcome> {
  try {
    const pages = await readPlanPages(input.data, input.fileName);
    const sheets: SheetAnalysis[] = [];
    const skipped: DrawingAnalysis['skipped'] = [];
    for (const page of pages) {
      try {
        sheets.push(await analyseSheet(page, input.readScannedText));
      } catch (error) {
        if (pages.length === 1) throw error;
        skipped.push({ page: page.page, reason: (error as Error).message });
      }
    }
    return { ok: true, analysis: { fileName: input.fileName, sheets, skipped } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof DrawingReadError ||
      error instanceof NoGridError ||
      (error instanceof Error && error.name === 'PdfReadError')
    ) {
      return { ok: false, kind: 'unreadable', message };
    }
    return { ok: false, kind: 'internal', message };
  }
}

async function analyseSheet(plan: PlanSource, readScannedText: boolean): Promise<SheetAnalysis> {
  const warnings = [...plan.warnings];

  // Square the sheet up first: the grid is read along rows and columns.
  let image = plan.image;
  let fileTexts = plan.texts;
  const skew = estimateSkew(image);
  if (skew.degrees) {
    ({ image, texts: fileTexts } = await unturn(image, fileTexts, skew.degrees));
    warnings.push(`The page was turned ${skew.degrees.toFixed(2)}° and has been squared up.`);
  }

  let map: PlanMap;
  try {
    map = analyseGrid(image);
  } catch (error) {
    if (!(error instanceof NoGridError)) throw error;
    map = analyseOutlines(image);
  }
  warnings.push(...map.warnings);

  let planTexts: Array<PlanText & { source: 'file' | 'ocr'; confidence: number }> = fileTexts.map(
    (t) => ({ ...t, source: 'file' as const, confidence: 100 }),
  );
  if (!planTexts.length && readScannedText && plan.format !== 'pdf-vector') {
    try {
      planTexts = await ocrTexts(image);
    } catch (error) {
      warnings.push(
        `The words on the plan could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const ux = (px: number) => (px - map.originX) / map.unitPxX;
  const uy = (py: number) => (py - map.originY) / map.unitPxY;
  const texts: AnalysedText[] = planTexts.map((t) => ({
    text: t.text,
    x: round(ux(t.x)),
    y: round(uy(t.y)),
    width: round(t.width / map.unitPxX),
    height: round(t.height / map.unitPxY),
    source: t.source,
    confidence: Math.round(t.confidence),
    swatch: swatchLeftOf(image, t),
  }));

  const dimensions: AnalysedDimension[] = findDimensionLines(
    image,
    planTexts,
    map.source === 'grid' ? { x: map.unitPxX, y: map.unitPxY } : null,
  ).map((d: DimensionLine) => ({
    text: d.text,
    value: d.value,
    unit: d.unit,
    units: round(
      d.vertical ? Math.abs(d.y2 - d.y1) / map.unitPxY : Math.abs(d.x2 - d.x1) / map.unitPxX,
    ),
    x1: round(ux(d.x1)),
    y1: round(uy(d.y1)),
    x2: round(ux(d.x2)),
    y2: round(uy(d.y2)),
    vertical: d.vertical,
  }));

  const scale = Math.min(1, PREVIEW_SIDE / Math.max(image.width, image.height));
  const jpeg = await encodePreview(image, PREVIEW_SIDE);
  const { cells, regionOf, warnings: mapWarnings, originX, originY, ...mapRest } = map;
  void mapWarnings;
  return {
    page: plan.page,
    format: plan.format,
    rotation: skew.degrees,
    warnings,
    map: {
      ...mapRest,
      cells: Buffer.from(cells.buffer, cells.byteOffset, cells.byteLength).toString('base64'),
      regionOf: Buffer.from(regionOf).toString('base64'),
    },
    preview: {
      jpeg: jpeg.toString('base64'),
      width: Math.round(image.width * scale),
      height: Math.round(image.height * scale),
      originX: round(originX * scale),
      originY: round(originY * scale),
      unitPxX: round(map.unitPxX * scale),
      unitPxY: round(map.unitPxY * scale),
    },
    texts,
    dimensions,
    statedGrid: statedGridSize(planTexts.map((t) => t.text)),
    fileScale:
      plan.metresPerPx !== null
        ? {
            metresPerUnit: plan.metresPerPx * ((map.unitPxX + map.unitPxY) / 2),
            detail: plan.scaleSource ?? 'The file states its scale',
          }
        : null,
  };
}

export function decodeMapCells(map: SheetAnalysis['map']): Int16Array {
  const bytes = Buffer.from(map.cells, 'base64');
  const out = new Int16Array(map.cols * map.rows);
  new Uint8Array(out.buffer).set(bytes.subarray(0, out.byteLength));
  return out;
}

export function decodeRegions(map: SheetAnalysis['map']): Uint8Array {
  const bytes = Buffer.from(map.regionOf, 'base64');
  return bytes.length === map.cols * map.rows
    ? new Uint8Array(bytes)
    : new Uint8Array(map.cols * map.rows).fill(0);
}

export type { OverlayGroup };

/**
 * The colour drawn just left of a text: a legend row's swatch. Looks at a strip as tall as the
 * text and up to four text-heights wide, ending a little before the text.
 */
function swatchLeftOf(img: RgbImage, t: PlanText): AnalysedText['swatch'] {
  const h = Math.max(4, Math.min(t.width, t.height));
  const x1 = Math.round(t.x - 0.3 * h);
  const x0 = Math.round(t.x - 4 * h);
  const y0 = Math.round(t.y + 0.1 * t.height);
  const y1 = Math.round(t.y + 0.9 * t.height);
  const tally = new Map<ColorFamily, { n: number; r: number; g: number; b: number }>();
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      const k = 3 * (y * img.width + x);
      const [r, g, b] = [img.data[k], img.data[k + 1], img.data[k + 2]];
      n++;
      const family = colorFamily(r, g, b);
      if (family === 'white' || family === 'dark') continue;
      let e = tally.get(family);
      if (!e) tally.set(family, (e = { n: 0, r: 0, g: 0, b: 0 }));
      e.n++;
      e.r += r;
      e.g += g;
      e.b += b;
    }
  }
  if (!n) return null;
  const best = [...tally].sort((a, b) => b[1].n - a[1].n)[0];
  // A swatch fills a good part of the strip; a stray line does not.
  if (!best || best[1].n < 0.12 * n) return null;
  const [family, e] = best;
  const hex = (v: number) =>
    Math.round(v / e.n)
      .toString(16)
      .padStart(2, '0');
  return { family, color: `#${hex(e.r)}${hex(e.g)}${hex(e.b)}` };
}

// ---- OCR of scanned plans ------------------------------------------------------------------

/** Plans print small: OCR reads them enlarged. */
const OCR_SCALE = 3;
/** Largest image handed to OCR, in pixels (after enlarging), to bound time and memory. */
const OCR_MAX_PIXELS = 60_000_000;

type OcrText = PlanText & { source: 'ocr'; confidence: number };

/**
 * Reads the words of a scanned plan with Tesseract (open source, runs locally, no service).
 *
 * The page is first reduced to its ink: dark lines and strongly coloured text stay, while
 * light grid lines, hatching and grey fills go, since OCR reads them as letters. It is read
 * twice, upright and turned a quarter, because plans print dimensions and room names up the
 * page too. Lines OCR is unsure of, and lines without a letter or digit, are dropped.
 */
async function ocrTexts(img: RgbImage): Promise<OcrText[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharp = require('sharp') as typeof import('sharp').default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tesseract = require('tesseract.js') as typeof import('tesseract.js');
  const scale = Math.max(
    1,
    Math.min(OCR_SCALE, Math.sqrt(OCR_MAX_PIXELS / (img.width * img.height))),
  );
  const ink = new Uint8Array(img.width * img.height);
  for (let i = 0; i < ink.length; i++) {
    const r = img.data[3 * i];
    const g = img.data[3 * i + 1];
    const b = img.data[3 * i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const max = Math.max(r, g, b);
    const sat = max ? (max - Math.min(r, g, b)) / max : 0;
    // Ink keeps its own shade (smooth edges read better); everything else turns white.
    ink[i] = lum < 150 || (sat > 0.5 && lum < 170) ? Math.min(255, Math.round(lum * 0.6)) : 255;
  }
  const raw = { raw: { width: img.width, height: img.height, channels: 1 as const } };
  const W = Math.round(img.width * scale);
  const H = Math.round(img.height * scale);
  const upright = await sharp(Buffer.from(ink), raw)
    .resize(W, H, { kernel: 'cubic' })
    .png()
    .toBuffer();
  // Turned a quarter clockwise, text printed up the page reads left to right. (sharp turns
  // before it resizes, so the turned picture is sized H x W.)
  const turned = await sharp(Buffer.from(ink), raw)
    .rotate(90)
    .resize(H, W, { kernel: 'cubic' })
    .png()
    .toBuffer();

  const langPath = join(
    require.resolve('@tesseract.js-data/eng/package.json'),
    '..',
    '4.0.0_best_int',
  );
  const worker = await tesseract.createWorker('eng', 1, {
    langPath,
    cacheMethod: 'none',
    gzip: true,
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT });
    const out: OcrText[] = [];
    for (const [picture, turn] of [
      [upright, false],
      [turned, true],
    ] as const) {
      const { data } = await worker.recognize(picture, {}, { blocks: true });
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            const text = cleanLine(line.words);
            if (!text || line.confidence < 55 || !isWordy(text.text)) continue;
            const { x0, y0, x1, y1 } = text.box;
            // Back to the page: the turned picture's (x, y) is the page's (W - y, x).
            const box = turn
              ? {
                  // The picture was turned a quarter clockwise: its (u, v) is the page's
                  // (v, H - u).
                  x: y0 / scale,
                  y: (img.height * scale - x1) / scale,
                  width: (y1 - y0) / scale,
                  height: (x1 - x0) / scale,
                }
              : {
                  x: x0 / scale,
                  y: y0 / scale,
                  width: (x1 - x0) / scale,
                  height: (y1 - y0) / scale,
                };
            // The turned reading keeps only what is printed up the page; the upright one has
            // the rest.
            if (turn && box.height < box.width) continue;
            out.push({ text: text.text, ...box, source: 'ocr', confidence: line.confidence });
          }
        }
      }
    }
    return out;
  } finally {
    await worker.terminate();
  }
}

/**
 * A line's text without the scraps OCR makes of the drawing around it: a legend's swatch read
 * as a leading "I" or "EEN", or the ticks of a dimension line read as "|" on either side.
 */
function cleanLine(
  words: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }>,
): { text: string; box: { x0: number; y0: number; x1: number; y1: number } } | null {
  const kept = words.filter((w) => w.text.trim());
  const symbolsOnly = (w: { text: string }) => !/[\p{L}\p{N}]/u.test(w.text);
  while (kept.length >= 2 && symbolsOnly(kept[0])) kept.shift();
  while (kept.length >= 2 && symbolsOnly(kept[kept.length - 1])) kept.pop();
  while (kept.length >= 2 && isStrayWord(kept[0].text) && kept.length >= 3) kept.shift();
  // A dimension's number with its line's ticks read as letters around it ("1 40.00 y").
  const numbers = kept.filter((w) => /^\d{1,6}[.,]\d{1,3}$/.test(w.text.trim()));
  if (numbers.length === 1 && kept.every((w) => w === numbers[0] || w.text.trim().length <= 1)) {
    kept.splice(0, kept.length, numbers[0]);
  }
  if (!kept.length) return null;
  const text = kept
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    text,
    box: {
      x0: Math.min(...kept.map((w) => w.bbox.x0)),
      y0: Math.min(...kept.map((w) => w.bbox.y0)),
      x1: Math.max(...kept.map((w) => w.bbox.x1)),
      y1: Math.max(...kept.map((w) => w.bbox.y1)),
    },
  };
}

/** A short scrap OCR makes of a symbol: symbols, or up to three letters that are not a word. */
function isStrayWord(word: string): boolean {
  const w = word.trim();
  if (/[^\p{L}\p{N}().,/&-]/u.test(w)) return true;
  return (
    /^\p{L}{1,3}$/u.test(w) &&
    !/^(?:a|an|of|to|in|on|at|by|for|and|the|no|nc|hr|ep|fhc|lift|gate|exit|way)$/i.test(w)
  );
}

/** At least two letters or digits, more of them than symbols, and a word or a plain number. */
function isWordy(text: string): boolean {
  const alnum = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const symbols = (text.match(/[^\p{L}\p{N}\s]/gu) ?? []).length;
  if (alnum < 2 || symbols >= alnum) return false;
  return /\p{L}/u.test(text) || /^\d+(?:[.,]\d+)?$/.test(text);
}

const round = (v: number) => Math.round(v * 1000) / 1000;
