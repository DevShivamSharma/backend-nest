import type { CadDrawing } from './cad-drawing';
import { DxfReadError, readDxf } from './dxf-reader';
import { estimatePitch } from './grid-map';
import { PdfReadError, readPageVectors } from './pdf-vectors';
import {
  decodeImage,
  drawPrimitives,
  DrawingReadError,
  MAX_PIXELS,
  PixelFill,
  PixelSegment,
  RgbImage,
} from './raster';

/** A text printed on the plan, in pixels of the plan image (y down). */
export interface PlanText {
  text: string;
  /** Left, top, width and height of its box. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PlanFormat = 'pdf-scan' | 'pdf-vector' | 'dxf' | 'image';

/** One page of a hall plan, as an image to find the grid on and the texts the file holds. */
export interface PlanSource {
  format: PlanFormat;
  /** 1-based page of the document. */
  page: number;
  image: RgbImage;
  /** Texts the file holds as text. A scan or a picture holds none: they are read by eye. */
  texts: PlanText[];
  /**
   * Metres per image pixel when the file itself says (a DXF's units, a CAD PDF's printed
   * "SCALE 1:200"); null when only the plan's contents can tell.
   */
  metresPerPx: number | null;
  /** How `metresPerPx` is known. */
  scaleSource: string | null;
  warnings: string[];
}

/** Pages read from one document; more is refused rather than read half-way. */
export const MAX_PAGES = 8;

/** Longest side a vector plan is first drawn at; enlarged when its grid comes out too fine. */
const FIRST_SIDE = 4000;
/** Pixels per grid cell a drawn vector plan should have for an exact reading. */
const WANTED_PITCH = 10;

export function planFormatOf(fileName: string, data: Uint8Array): 'pdf' | 'dxf' | 'image' | null {
  const head = Buffer.from(data.subarray(0, 1024)).toString('latin1');
  if (head.startsWith('%PDF-')) return 'pdf';
  if (/\.dxf$/i.test(fileName) || /^\s*0\s*\r?\n\s*SECTION/.test(head)) return 'dxf';
  if (/^\x89PNG|^\xff\xd8\xff|^RIFF....WEBP|^II\*\0|^MM\0\*/s.test(head)) return 'image';
  return null;
}

/** Every page of a plan document (images and DXF have one). */
export async function readPlanPages(data: Uint8Array, fileName: string): Promise<PlanSource[]> {
  const kind = planFormatOf(fileName, data);
  if (kind === 'image') {
    return [
      {
        format: 'image',
        page: 1,
        image: await decodeImage(data),
        texts: [],
        metresPerPx: null,
        scaleSource: null,
        warnings: [],
      },
    ];
  }
  if (kind === 'dxf') return [readDxfPlan(data)];
  if (kind === 'pdf') {
    const count = await pdfPageCount(data);
    if (count > MAX_PAGES) {
      throw new DrawingReadError(
        `The PDF has ${count} pages; upload at most ${MAX_PAGES} pages of hall plans at a time.`,
      );
    }
    const pages: PlanSource[] = [];
    for (let page = 1; page <= count; page++) {
      try {
        pages.push(await readPdfPlan(data, page));
      } catch (error) {
        // A page without a drawing (a cover, a notes page) is skipped, not fatal.
        if (!(error instanceof DrawingReadError) || count === 1) throw error;
      }
    }
    if (!pages.length) throw new DrawingReadError('No page of the PDF holds a drawing.');
    return pages;
  }
  if (/\.dwg$/i.test(fileName)) {
    throw new DrawingReadError(
      'DWG files cannot be read directly. Save the drawing as DXF or PDF from AutoCAD and upload that.',
    );
  }
  throw new DrawingReadError('Upload a PDF, DXF, PNG, JPG, WebP or TIFF plan.');
}

// ---- PDF --------------------------------------------------------------------------------------

async function pdfPageCount(data: Uint8Array): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js') as PdfJs;
  try {
    const doc = await pdfjs.getDocument({
      data: data.slice(),
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
    const count = doc.numPages;
    await doc.destroy();
    return count;
  } catch (error) {
    throw new PdfReadError(`Not a readable PDF: ${(error as Error).message}`);
  }
}

async function readPdfPlan(data: Uint8Array, page: number): Promise<PlanSource> {
  const warnings: string[] = [];
  const vectors = await readPageVectors(data.slice(), page);
  const segmentCount = vectors.paths.reduce((n, p) => n + p.segments.length, 0);
  const scan = await largestImage(data, page);

  // A scan: the drawing is one picture. Lines drawn over it (a frame, a stamp) are ignored.
  if (scan && segmentCount < 2000) {
    const texts = vectors.texts.flatMap((t) => {
      const [x, y] = scan.toImage(t.x, t.y);
      const h = t.size * scan.scale;
      return h > 0 ? [boxAround(t.text, x, y, h, t.vertical)] : [];
    });
    return {
      format: 'pdf-scan',
      page,
      image: scan.image,
      texts: joinLineFragments(texts),
      // A scan's resolution is not the drawing's scale: the scale comes from its contents.
      metresPerPx: null,
      scaleSource: null,
      warnings,
    };
  }
  if (!segmentCount) {
    throw new DrawingReadError(`Page ${page} of the PDF has no drawing and no picture of one.`);
  }

  // A vector drawing: draw it ourselves, one pixel per line.
  const segments: Array<[number, number, number, number, string | null]> = [];
  const fills: Array<{ points: number[]; color: string | null }> = [];
  for (const path of vectors.paths) {
    if (path.stroke !== null || !path.fill) {
      for (const s of path.segments) segments.push([s.x1, s.y1, s.x2, s.y2, path.stroke]);
    }
    if (path.fill && path.segments.length >= 3) {
      const points: number[] = [];
      for (const s of path.segments) points.push(s.x1, s.y1);
      fills.push({ points, color: path.fill });
    }
  }
  const texts = vectors.texts.map((t) => ({
    text: t.text,
    x: t.x,
    y: t.y,
    h: t.size,
    v: t.vertical,
  }));
  // A plotted CAD sheet that states its scale: paper points convert to metres.
  const stated = statedScale(texts.map((t) => t.text));
  const plan = drawVector('pdf-vector', page, segments, fills, texts, warnings);
  if (stated) {
    plan.metresPerPx = (POINT_METRES * stated) / plan.pxPerSourceUnit;
    plan.scaleSource = `The sheet states SCALE 1:${stated} (assuming it is printed at full size)`;
  }
  return plan;
}

/** One PDF point in metres on paper. */
const POINT_METRES = 0.0254 / 72;

/** "SCALE 1:200", "Scale - 1 : 500": the ratio a plotted plan states. */
export function statedScale(texts: string[]): number | null {
  const votes = new Map<number, number>();
  for (const text of texts) {
    const match =
      /\bscale\b\s*[:=-]?\s*1\s*:\s*(\d{2,4})\b/i.exec(text) ??
      /^\s*1\s*:\s*(\d{2,4})\s*$/.exec(text);
    if (!match) continue;
    const n = Number(match[1]);
    if (n >= 20 && n <= 5000) votes.set(n, (votes.get(n) ?? 0) + (/scale/i.test(text) ? 3 : 1));
  }
  let best: number | null = null;
  let most = 0;
  for (const [n, count] of votes) if (count > most) [best, most] = [n, count];
  return best;
}

/** The largest picture on a page, with the mapping from page points to its pixels. */
async function largestImage(
  data: Uint8Array,
  pageNumber: number,
): Promise<{
  image: RgbImage;
  scale: number;
  toImage: (x: number, y: number) => [number, number];
} | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js') as PdfJs;
  const doc = await pdfjs.getDocument({
    data: data.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const ops = await page.getOperatorList();
    const O = pdfjs.OPS;
    let ctm = viewport.transform.slice();
    const stack: number[][] = [];
    let best: { name: string; matrix: number[]; area: number } | null = null;
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i] as unknown[];
      if (fn === O.save) stack.push(ctm.slice());
      else if (fn === O.restore) ctm = stack.pop() ?? ctm;
      else if (fn === O.transform) ctm = multiply(ctm, args as number[]);
      else if (fn === O.paintImageXObject) {
        const area = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
        if (!best || area > best.area) best = { name: String(args[0]), matrix: ctm.slice(), area };
      }
    }
    if (!best) return null;
    const name = best.name;
    const raw = await new Promise<PdfImage | null>((resolve) => {
      try {
        page.objs.get(name, (img: PdfImage) => resolve(img ?? null));
      } catch {
        resolve(null);
      }
    });
    if (!raw || !raw.width || !raw.height || raw.width * raw.height > MAX_PIXELS) return null;
    const image = toRgb(raw);
    if (!image) return null;
    // Image space: the unit square, (0,0) at the bottom left of the picture.
    const m = best.matrix;
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det) return null;
    const toImage = (x: number, y: number): [number, number] => {
      const dx = x - m[4];
      const dy = y - m[5];
      const u = (m[3] * dx - m[2] * dy) / det;
      const v = (-m[1] * dx + m[0] * dy) / det;
      return [u * image.width, (1 - v) * image.height];
    };
    const pageHeightInPixels = Math.hypot(m[2], m[3]);
    return { image, scale: image.height / (pageHeightInPixels || image.height), toImage };
  } finally {
    await doc.destroy();
  }
}

interface PdfImage {
  width: number;
  height: number;
  /** 1: 1-bit grey, 2: RGB, 3: RGBA. */
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}

function toRgb(img: PdfImage): RgbImage | null {
  const n = img.width * img.height;
  if (img.kind === 2 && img.data.length >= n * 3) {
    return {
      width: img.width,
      height: img.height,
      data: new Uint8Array(img.data.subarray(0, n * 3)),
    };
  }
  if (img.kind === 3 && img.data.length >= n * 4) {
    const out = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = img.data[4 * i + 3] / 255;
      for (let c = 0; c < 3; c++)
        out[3 * i + c] = Math.round(img.data[4 * i + c] * a + 255 * (1 - a));
    }
    return { width: img.width, height: img.height, data: out };
  }
  if (img.kind === 1) {
    const rowBytes = Math.ceil(img.width / 8);
    const out = new Uint8Array(n * 3);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const bit = (img.data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        out.fill(bit ? 255 : 0, 3 * (y * img.width + x), 3 * (y * img.width + x) + 3);
      }
    }
    return { width: img.width, height: img.height, data: out };
  }
  return null;
}

// ---- DXF --------------------------------------------------------------------------------------

function readDxfPlan(data: Uint8Array): PlanSource {
  let drawing: CadDrawing;
  try {
    drawing = readDxf(data);
  } catch (error) {
    if (error instanceof DxfReadError) throw new DrawingReadError(error.message);
    throw error;
  }
  // CAD is y up; images are y down.
  const segments: Array<[number, number, number, number, string | null]> = [];
  for (const line of drawing.polylines) {
    const p = line.points;
    const count = p.length / 2;
    for (let i = 0; i + 1 < count + (line.closed ? 1 : 0); i++) {
      const j = (i + 1) % count;
      segments.push([p[2 * i], -p[2 * i + 1], p[2 * j], -p[2 * j + 1], line.color]);
    }
  }
  const fills = drawing.fills.flatMap((f) =>
    f.loops.map((loop) => ({
      points: loop.map((v, i) => (i % 2 ? -v : v)),
      color: f.color,
    })),
  );
  const texts = drawing.texts.map((t) => ({
    text: t.text,
    x: t.x,
    y: -t.y,
    h: t.height,
    v: false,
  }));
  const plan = drawVector('dxf', 1, segments, fills, texts, [...drawing.warnings]);
  if (drawing.metresPerUnit !== null) {
    plan.metresPerPx = drawing.metresPerUnit / plan.pxPerSourceUnit;
    plan.scaleSource = `The DXF states its units (${drawing.scaleSource})`;
  }
  return plan;
}

// ---- vector drawing -----------------------------------------------------------------------------

function drawVector(
  format: 'pdf-vector' | 'dxf',
  page: number,
  segments: Array<[number, number, number, number, string | null]>,
  fills: Array<{ points: number[]; color: string | null }>,
  texts: Array<{ text: string; x: number; y: number; h: number; v: boolean }>,
  warnings: string[],
): PlanSource & { pxPerSourceUnit: number } {
  // The drawing's extent, ignoring a few far-flung strays (a title block's origin, a stray point).
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of segments) {
    xs.push(s[0], s[2]);
    ys.push(s[1], s[3]);
  }
  if (!xs.length) throw new DrawingReadError('The drawing has no lines.');
  const minX = quantile(xs, 0.001);
  const maxX = quantile(xs, 0.999);
  const minY = quantile(ys, 0.001);
  const maxY = quantile(ys, 0.999);
  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);
  const margin = 8;

  const draw = (side: number) => {
    const scale = side / Math.max(spanX, spanY);
    const width = Math.ceil(spanX * scale) + 2 * margin;
    const height = Math.ceil(spanY * scale) + 2 * margin;
    const px = (x: number) => (x - minX) * scale + margin;
    const py = (y: number) => (y - minY) * scale + margin;
    const pixelSegments = function* (): Generator<PixelSegment> {
      for (const s of segments) {
        yield { x1: px(s[0]), y1: py(s[1]), x2: px(s[2]), y2: py(s[3]), color: rgb(s[4]) };
      }
    };
    const pixelFills = function* (): Generator<PixelFill> {
      for (const f of fills) {
        // White fills are masks behind text; drawing them would erase grid lines under labels.
        if (!f.color || /^#f[0-9a-f]f[0-9a-f]f[0-9a-f]$/i.test(f.color)) continue;
        yield { points: f.points.map((v, i) => (i % 2 ? py(v) : px(v))), color: rgb(f.color) };
      }
    };
    const image = drawPrimitives(width, height, pixelFills(), pixelSegments());
    const planTexts = texts.map((t) => boxAround(t.text, px(t.x), py(t.y), t.h * scale, t.v));
    return { image, texts: planTexts, scale };
  };

  let side = FIRST_SIDE;
  let drawn = draw(side);
  const pitch = estimatePitch(drawn.image);
  if (pitch && pitch < WANTED_PITCH * 0.8) {
    // The longest side that keeps the image within the pixel limit.
    const aspect = Math.max(spanX, spanY) / Math.min(spanX, spanY);
    const largest = Math.sqrt(MAX_PIXELS * 0.9 * aspect);
    const larger = Math.min(side * (WANTED_PITCH / pitch), largest);
    if (larger > side * 1.1) {
      side = larger;
      try {
        drawn = draw(side);
      } catch {
        warnings.push('The drawing is very large; its grid was read at a coarser scale.');
      }
    }
  }
  return {
    format,
    page,
    image: drawn.image,
    texts: joinLineFragments(drawn.texts),
    metresPerPx: null,
    scaleSource: null,
    warnings,
    pxPerSourceUnit: drawn.scale,
  };
}

/**
 * CAD exports often write one line of text as several pieces ("FIRE", "HOSE", "REEL"). Pieces
 * on one baseline, of one size, close together, are joined into the line they form: a legend
 * row or a room name must be read whole.
 */
export function joinLineFragments(texts: PlanText[]): PlanText[] {
  const sorted = [...texts]
    .filter((t) => t.width >= t.height * 0.5 || t.text.length <= 2)
    .sort((a, b) => a.x - b.x);
  const rest = texts.filter((t) => !sorted.includes(t));
  const used = new Set<PlanText>();
  const out: PlanText[] = [];
  for (const start of sorted) {
    if (used.has(start)) continue;
    used.add(start);
    let line = { ...start };
    for (;;) {
      const h = line.height;
      const cy = line.y + h / 2;
      const right = line.x + line.width;
      const next = sorted.find(
        (t) =>
          !used.has(t) &&
          Math.abs(t.height - h) <= 0.25 * h &&
          Math.abs(t.y + t.height / 2 - cy) <= 0.35 * h &&
          t.x - right >= -0.5 * h &&
          t.x - right <= 1.5 * h,
      );
      if (!next) break;
      used.add(next);
      const x1 = Math.max(right, next.x + next.width);
      line = {
        text: `${line.text} ${next.text}`,
        x: line.x,
        y: Math.min(line.y, next.y),
        width: x1 - line.x,
        height: Math.max(line.height, next.height),
      };
    }
    out.push(line);
  }
  return [...out, ...rest];
}

/** A text's box from its centre and height (vertical text runs up the page). */
function boxAround(text: string, cx: number, cy: number, h: number, vertical: boolean): PlanText {
  const length = 0.6 * h * text.length;
  return vertical
    ? { text, x: cx - h / 2, y: cy - length / 2, width: h, height: length }
    : { text, x: cx - length / 2, y: cy - h / 2, width: length, height: h };
}

function rgb(hex: string | null): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  if (!m) return [0, 0, 0];
  const c: [number, number, number] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  // CAD draws "white" lines on a black screen: on paper they are black.
  return c[0] > 245 && c[1] > 245 && c[2] > 245 ? [0, 0, 0] : c;
}

function quantile(values: number[], q: number): number {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/** a · b for PDF matrices [a b c d e f] (b applied first). */
function multiply(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

interface PdfJs {
  getDocument(src: Record<string, unknown>): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getViewport(o: { scale: number }): { transform: number[] };
        getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
        objs: { get(name: string, callback: (value: PdfImage) => void): void };
      }>;
      destroy(): Promise<void>;
    }>;
  };
  OPS: Record<string, number>;
}

export { DrawingReadError, PdfReadError };
