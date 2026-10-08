import { createCanvas, loadImage, Canvas, GlobalFonts } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';
import { dirname, join } from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { detectGrids } from './analyse';
import { readIsolatedPdfDrawing } from './cad/isolated-reader';
import type { CadDrawing } from './cad/cad-drawing';
import type { Point, TextBox } from './plan.types';

export interface Segment {
  a: Point;
  b: Point;
  color: string;
  width: number;
  dashed: boolean;
  gridCandidate?: boolean;
}
export interface Fill {
  rings: Point[][];
  color: string;
}
export interface SourcePage {
  number: number;
  width: number;
  height: number;
  preview: string;
  texts: TextBox[];
  lines: Segment[];
  fills: Fill[];
  format: 'pdf-vector' | 'pdf-scan' | 'image' | 'dxf';
  unitMetres: number | null;
  warnings: string[];
  cad?: CadDrawing;
}
const drawingFont =
  ['Arial', 'Liberation Sans', 'DejaVu Sans', 'Noto Sans'].find((name) => GlobalFonts.has(name)) ??
  'sans-serif';
type Matrix = [number, number, number, number, number, number];
const identity: Matrix = [1, 0, 0, 1, 0, 0];
function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
const point = (m: Matrix, x: number, y: number): Point => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
// Native import is needed because the Nest application is CommonJS and PDF.js is ESM.
const nativeImport = new Function('specifier', 'return import(specifier)') as (
  s: string,
) => Promise<typeof import('pdfjs-dist')>;

export async function readSource(
  data: Uint8Array,
  fileName: string,
  onPage?: (page: SourcePage) => void,
): Promise<SourcePage[]> {
  const signature = Buffer.from(data.slice(0, 1024)).indexOf('%PDF-');
  if (signature >= 0 || /\.pdf$/i.test(fileName)) return readPdf(data, onPage);
  if (/\.dxf$/i.test(fileName)) return readDxf(Buffer.from(data).toString('utf8'));
  const image = await loadImage(Buffer.from(data));
  if (image.width * image.height > 40_000_000)
    throw new Error('Image exceeds 40 megapixels. Resize it before uploading.');
  const scale = Math.min(1, 3200 / Math.max(image.width, image.height));
  const canvas = createCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  const page: SourcePage = {
    number: 1,
    width: canvas.width,
    height: canvas.height,
    preview: canvas.toDataURL('image/png'),
    texts: [],
    lines: [],
    fills: [],
    format: 'image',
    unitMetres: null,
    warnings: [],
  };
  await readRaster(page, canvas).catch((error) =>
    page.warnings.push(
      `Automatic detection incomplete: ${error.message}. Review the original image manually.`,
    ),
  );
  return [page];
}

async function readPdf(
  data: Uint8Array,
  onPage?: (page: SourcePage) => void,
): Promise<SourcePage[]> {
  const cadData = new Uint8Array(data);
  const pdf = await nativeImport(
    pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href,
  );
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  const task = pdf.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    standardFontDataUrl: root + '/standard_fonts/',
    cMapUrl: root + '/cmaps/',
    cMapPacked: true,
    verbosity: 0,
  });
  try {
    const doc = await task.promise.catch(async (error) => {
      throw new Error(`PDF parser could not open this document: ${error.message}`);
    });
    if (doc.numPages > 50)
      throw new Error('Import at most 50 pages at a time. Split this document first.');
    const content = await doc.getOptionalContentConfig().catch(() => null);
    const hasCadGrid = [...(content ?? [])].some(([, group]) =>
      /^(?:stall[ _-]*)?grid(?:[ _-]*lines)?$/i.test(
        String(group.name)
          .split(/\$0\$|\|/)
          .pop()!,
      ),
    );
    const pages: SourcePage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      try {
        const p = await doc.getPage(n),
          viewport = p.getViewport({ scale: 1 });
        const s: SourcePage = {
          number: n,
          width: viewport.width,
          height: viewport.height,
          preview: '',
          texts: [],
          lines: [],
          fills: [],
          format: 'pdf-vector',
          unitMetres: null,
          warnings: [
            'Curved paths are approximated by line segments; verify curved boundaries at maximum zoom.',
          ],
        };
        const text = await p.getTextContent().catch(() => {
          s.warnings.push('Selectable text could not be extracted; OCR will be attempted.');
          return { items: [] };
        });
        for (const item of text.items)
          if ('str' in item && item.str.trim()) {
            const m = mul(viewport.transform as Matrix, item.transform as Matrix),
              h = Math.hypot(m[2], m[3]);
            s.texts.push({
              text: item.str.trim(),
              x: m[4],
              y: m[5] - h,
              width: item.width,
              height: h,
              source: 'vector',
              confidence: 1,
            });
          }
        const ops = await p.getOperatorList().catch(() => ({ fnArray: [], argsArray: [] }));
        const vectorLimit = ops.fnArray.length > 500_000;
        if (vectorLimit)
          s.warnings.push(
            'Dense vector drawing: image-based detection was used instead of rejecting this page.',
          );
        const O = pdf.OPS;
        let state = {
          m: viewport.transform as Matrix,
          color: '#000000',
          fill: '#000000',
          width: 1,
          dashed: false,
        };
        const stack: (typeof state)[] = [];
        for (let i = 0; !vectorLimit && i < ops.fnArray.length; i++) {
          const op = ops.fnArray[i],
            a = ops.argsArray[i] as any[];
          if (op === O.save || op === O.paintFormXObjectBegin) {
            stack.push({ ...state, m: [...state.m] });
            if (op === O.paintFormXObjectBegin && a[0]) state.m = mul(state.m, a[0]);
          } else if (op === O.restore || op === O.paintFormXObjectEnd) state = stack.pop() ?? state;
          else if (op === O.transform) state.m = mul(state.m, a as Matrix);
          else if (op === O.setStrokeRGBColor) state.color = String(a[0]);
          else if (op === O.setFillRGBColor) state.fill = String(a[0]);
          else if (op === O.setLineWidth) state.width = a[0];
          else if (op === O.setDash) state.dashed = !!a[0]?.length;
          else if (op === O.constructPath && a[1]?.[0]?.length) {
            const draw = Array.from(a[1][0]) as number[];
            const rings: Point[][] = [];
            let r: Point[] = [];
            const push = () => {
              if (r.length > 1) rings.push(r);
              r = [];
            };
            for (let j = 0; j < draw.length;) {
              const code = draw[j++];
              if (code === 0) {
                push();
                r.push(point(state.m, draw[j++], draw[j++]));
              } else if (code === 1) r.push(point(state.m, draw[j++], draw[j++]));
              else if (code === 2 || code === 3) {
                const start = r.at(-1) ?? [0, 0],
                  c1 = point(state.m, draw[j++], draw[j++]);
                const c2 = code === 2 ? point(state.m, draw[j++], draw[j++]) : c1;
                const end = point(state.m, draw[j++], draw[j++]);
                // Subdivide curves in source space. Review keeps this approximation explicit.
                for (let k = 1; k <= 16; k++) {
                  const t = k / 16,
                    u = 1 - t;
                  r.push(
                    code === 2
                      ? [
                          u * u * u * start[0] +
                            3 * u * u * t * c1[0] +
                            3 * u * t * t * c2[0] +
                            t * t * t * end[0],
                          u * u * u * start[1] +
                            3 * u * u * t * c1[1] +
                            3 * u * t * t * c2[1] +
                            t * t * t * end[1],
                        ]
                      : [
                          u * u * start[0] + 2 * u * t * c1[0] + t * t * end[0],
                          u * u * start[1] + 2 * u * t * c1[1] + t * t * end[1],
                        ],
                  );
                }
              } else if (code === 4) {
                if (r.length) r.push([...r[0]]);
                push();
              } else break;
            }
            push();
            const paint = a[0],
              stroked = [
                O.stroke,
                O.closeStroke,
                O.fillStroke,
                O.eoFillStroke,
                O.closeFillStroke,
                O.closeEOFillStroke,
              ].includes(paint);
            if (stroked)
              for (const ring of rings)
                for (let k = 1; k < ring.length; k++) {
                  const a = ring[k - 1],
                    b = ring[k];
                  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.05)
                    s.lines.push({
                      a,
                      b,
                      color: state.color,
                      width: state.width * Math.hypot(state.m[0], state.m[1]),
                      dashed: state.dashed,
                    });
                }
            if (
              [
                O.fill,
                O.eoFill,
                O.fillStroke,
                O.eoFillStroke,
                O.closeFillStroke,
                O.closeEOFillStroke,
              ].includes(paint)
            ) {
              const closed = rings
                .filter((r) => r.length >= 3)
                .map((r) =>
                  r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1] ? r : [...r, r[0]],
                );
              if (closed.length) s.fills.push({ rings: closed, color: state.fill });
            }
          }
        }
        const scale = Math.min(4, 4000 / Math.max(s.width, s.height)),
          v = p.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(v.width), Math.ceil(v.height));
        await p.render({
          canvasContext: canvas.getContext('2d') as never,
          viewport: v,
          canvas: canvas as never,
        }).promise;
        s.preview = canvas.toDataURL('image/png');
        if (hasCadGrid) {
          try {
            s.cad = await readIsolatedPdfDrawing(cadData, n);
          } catch (error) {
            s.warnings.push(
              `CAD layer reader could not analyse this page: ${error instanceof Error ? error.message : 'unknown error'}. Image detection remains available.`,
            );
          }
        }
        if (s.lines.length < 20 || !detectGrids(s).length || s.texts.length < 5) {
          s.format = 'pdf-scan';
          const raster: SourcePage = {
            ...s,
            width: canvas.width,
            height: canvas.height,
            lines: [],
            texts: [],
          };
          await readRaster(raster, canvas, s.texts.length < 5).catch((error) =>
            raster.warnings.push(
              `Image detection incomplete: ${error.message}. The original page remains available for manual review.`,
            ),
          );
          const rasterLines: Segment[] = raster.lines.map((l) => ({
            ...l,
            a: [l.a[0] / scale, l.a[1] / scale],
            b: [l.b[0] / scale, l.b[1] / scale],
          }));
          if (s.lines.length < 20 || !detectGrids(s).length) s.lines.push(...rasterLines);
          if (s.texts.length < 5)
            s.texts = raster.texts.map((t) => ({
              ...t,
              x: t.x / scale,
              y: t.y / scale,
              width: t.width / scale,
              height: t.height / scale,
            }));
          s.warnings.push(...raster.warnings);
        }
        pages.push(s);
        onPage?.(s);
        p.cleanup();
      } catch (error) {
        const fallback = await popplerPages(data, n).catch(() => []);
        if (fallback.length) {
          pages.push(...fallback);
          fallback.forEach((p) => onPage?.(p));
        } else {
          const failed: SourcePage = {
            number: n,
            width: 1000,
            height: 1000,
            preview: '',
            lines: [],
            fills: [],
            texts: [],
            format: 'pdf-scan',
            unitMetres: null,
            warnings: [
              `Page ${n} could not be rendered: ${error instanceof Error ? error.message : 'unknown error'}. Other pages are retained; re-export this page separately.`,
            ],
          };
          pages.push(failed);
          onPage?.(failed);
        }
      }
    }
    if (!pages.some((p) => p.preview))
      throw new Error('No PDF page could be rendered. Re-export this file or remove its password.');
    return pages;
  } catch (error) {
    return await popplerPages(data, undefined, onPage).catch(() => {
      throw error;
    });
  } finally {
    await task.destroy();
  }
}

async function readRaster(page: SourcePage, canvas: Canvas, ocr = true): Promise<void> {
  const cvModule = require('@techstark/opencv-js');
  const cv = await cvModule;
  const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  // Isolate neutral, long grid strokes before edge detection. Their centres avoid
  // counting the two sides of one raster stroke as two different grid lines.
  const neutral = new cv.Mat(canvas.height, canvas.width, cv.CV_8UC1);
  try {
    for (let i = 0; i < canvas.width * canvas.height; i++) {
      const r = image.data[i * 4],
        g = image.data[i * 4 + 1],
        b = image.data[i * 4 + 2];
      neutral.data[i] =
        Math.max(r, g, b) - Math.min(r, g, b) < 35 &&
        Math.min(r, g, b) < 225 &&
        image.data[i * 4 + 3] > 128
          ? 255
          : 0;
    }
    const length = Math.max(20, Math.round(Math.max(canvas.width, canvas.height) / 100));
    for (const horizontal of [true, false]) {
      const kernel = cv.getStructuringElement(
          cv.MORPH_RECT,
          new cv.Size(horizontal ? length : 1, horizontal ? 1 : length),
        ),
        opened = new cv.Mat(),
        contours = new cv.MatVector(),
        hierarchy = new cv.Mat();
      try {
        cv.morphologyEx(neutral, opened, cv.MORPH_OPEN, kernel);
        cv.findContours(opened, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        for (let i = 0; i < Math.min(contours.size(), 20000); i++) {
          const contour = contours.get(i);
          try {
            const r = cv.boundingRect(contour);
            const thin = horizontal ? r.height : r.width,
              long = horizontal ? r.width : r.height;
            if (long < length || thin > Math.max(5, length / 4)) continue;
            const a: Point = horizontal
              ? [r.x, r.y + (r.height - 1) / 2]
              : [r.x + (r.width - 1) / 2, r.y];
            const b: Point = horizontal ? [r.x + r.width - 1, a[1]] : [a[0], r.y + r.height - 1];
            page.lines.push({
              a,
              b,
              color: '#666666',
              width: 1,
              dashed: false,
              gridCandidate: true,
            });
          } finally {
            contour.delete();
          }
        }
      } finally {
        kernel.delete();
        opened.delete();
        contours.delete();
        hierarchy.delete();
      }
    }
  } finally {
    neutral.delete();
  }
  const src = cv.matFromImageData(image),
    gray = new cv.Mat(),
    edges = new cv.Mat(),
    lines = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.Canny(gray, edges, 50, 150, 3);
    cv.HoughLinesP(edges, lines, 1, Math.PI / 720, 35, Math.max(18, canvas.width / 100), 5);
    for (let i = 0; i < Math.min(lines.data32S.length / 4, 60000); i++) {
      const p = lines.data32S;
      page.lines.push({
        a: [p[i * 4], p[i * 4 + 1]],
        b: [p[i * 4 + 2], p[i * 4 + 3]],
        color: '#777777',
        width: 1,
        dashed: false,
      });
    }
  } finally {
    src.delete();
    gray.delete();
    edges.delete();
    lines.delete();
  }
  page.warnings.push(
    'Image-based geometry needs visual confirmation; source resolution limits accuracy.',
  );
  if (!ocr) return;
  const worker = await createWorker('eng', 1, {
    langPath: join(
      dirname(require.resolve('@tesseract.js-data/eng/package.json')),
      '4.0.0_best_int',
    ),
    gzip: true,
    cacheMethod: 'none',
  });
  try {
    const result = await worker.recognize(
      canvas.toBuffer('image/png'),
      {},
      { blocks: true, text: true },
    );
    for (const block of result.data.blocks ?? [])
      for (const p of block.paragraphs)
        for (const l of p.lines) {
          page.texts.push({
            text: l.text.trim(),
            x: l.bbox.x0,
            y: l.bbox.y0,
            width: l.bbox.x1 - l.bbox.x0,
            height: l.bbox.y1 - l.bbox.y0,
            source: 'ocr',
            confidence: l.confidence / 100,
          });
        }
  } catch {
    page.warnings.push(
      'OCR could not complete. The original page is available for visual review and manual hall naming.',
    );
  } finally {
    await worker.terminate();
  }
  page.warnings.push(
    'Scanned geometry and OCR need visual confirmation. Original resolution limits accuracy.',
  );
}

async function readDxf(text: string): Promise<SourcePage[]> {
  const Parser = require('dxf-parser');
  const doc = new Parser().parseSync(text);
  if (!doc) throw new Error('The DXF could not be read. Use an ASCII DXF export.');
  const lines: Segment[] = [],
    texts: TextBox[] = [];
  let unsupported = 0;
  const units: Record<number, number> = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 7: 1000 };
  const entities = (items: any[], matrix: Matrix, depth = 0) => {
    if (depth > 12) throw new Error('DXF block nesting is too deep.');
    for (const e of items) {
      const m = matrix,
        color =
          '#' +
          Number(e.color ?? 0)
            .toString(16)
            .padStart(6, '0');
      const add = (a: any, b: any) =>
        lines.push({
          a: point(m, a.x, a.y),
          b: point(m, b.x, b.y),
          color,
          width: 0.1,
          dashed: !!e.lineType && e.lineType !== 'CONTINUOUS',
        });
      if (e.type === 'LINE' || e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
        const v = e.vertices ?? [];
        for (let i = 1; i < v.length; i++) add(v[i - 1], v[i]);
        if (e.shape && v.length) add(v.at(-1), v[0]);
        if (v.some((p: any) => p.bulge)) unsupported++;
      } else if (e.type === 'CIRCLE' || e.type === 'ARC') {
        const a = e.startAngle ?? 0,
          b = e.endAngle ?? Math.PI * 2,
          span = (b - a + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
        const pts = Array.from({ length: 97 }, (_, i) => ({
          x: e.center.x + e.radius * Math.cos(a + (span * i) / 96),
          y: e.center.y + e.radius * Math.sin(a + (span * i) / 96),
        }));
        for (let i = 1; i < pts.length; i++) add(pts[i - 1], pts[i]);
      } else if (e.type === 'TEXT' || e.type === 'MTEXT') {
        const p = point(m, (e.startPoint ?? e.position).x, (e.startPoint ?? e.position).y),
          h = Math.abs((e.textHeight ?? e.height ?? 1) * Math.hypot(m[0], m[1]));
        texts.push({
          text: String(e.text ?? '')
            .replace(/\\P/g, ' ')
            .replace(/\\[^;]+;/g, ''),
          x: p[0],
          y: p[1] - h,
          width: h * String(e.text ?? '').length * 0.55,
          height: h,
          source: 'vector',
          confidence: 1,
        });
      } else if (e.type === 'INSERT') {
        const block = doc.blocks[e.name];
        if (!block) {
          unsupported++;
          continue;
        }
        const angle = ((e.rotation ?? 0) * Math.PI) / 180,
          c = Math.cos(angle),
          s = Math.sin(angle);
        const local = mul(
          [
            c * (e.xScale ?? 1),
            s * (e.xScale ?? 1),
            -s * (e.yScale ?? 1),
            c * (e.yScale ?? 1),
            e.position.x,
            e.position.y,
          ],
          [1, 0, 0, 1, -(block.position?.x ?? 0), -(block.position?.y ?? 0)],
        );
        entities(block.entities, mul(m, local), depth + 1);
      } else unsupported++;
      if (lines.length > 250000)
        throw new Error('DXF exceeds the geometry limit. Export the required floor only.');
    }
  };
  entities(doc.entities, mul(identity, [1, 0, 0, -1, 0, 0]));
  if (!lines.length) throw new Error('No supported geometry was found in this DXF.');
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  const extend = (p: Point) => {
    x = Math.min(x, p[0]);
    y = Math.min(y, p[1]);
    right = Math.max(right, p[0]);
    bottom = Math.max(bottom, p[1]);
  };
  for (const l of lines) {
    extend(l.a);
    extend(l.b);
  }
  for (const t of texts) {
    extend([t.x, t.y]);
    extend([t.x + t.width, t.y + t.height]);
  }
  const width = right - x,
    height = bottom - y;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
    throw new Error('The DXF has no finite two-dimensional extent.');
  for (const l of lines) {
    l.a = [l.a[0] - x, l.a[1] - y];
    l.b = [l.b[0] - x, l.b[1] - y];
  }
  for (const t of texts) {
    t.x -= x;
    t.y -= y;
  }
  const scale = 2400 / Math.max(width, height),
    canvas = createCanvas(
      Math.max(1, Math.ceil(width * scale)),
      Math.max(1, Math.ceil(height * scale)),
    ),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  for (const l of lines) {
    ctx.strokeStyle = l.color;
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    ctx.moveTo(...l.a);
    ctx.lineTo(...l.b);
    ctx.stroke();
  }
  for (const t of texts) {
    ctx.fillStyle = 'black';
    ctx.font = `${t.height}px ${drawingFont}`;
    ctx.fillText(t.text, t.x, t.y + t.height);
  }
  return [
    {
      number: 1,
      width,
      height,
      preview: canvas.toDataURL('image/png'),
      texts,
      lines,
      fills: [],
      format: 'dxf',
      unitMetres: units[doc.header?.['$INSUNITS']] ?? null,
      warnings: unsupported
        ? [
            `${unsupported} unsupported DXF entities or bulged segments need manual review; use vector PDF for faithful source rendering.`,
          ]
        : [],
    },
  ];
}

const execute = promisify(execFile);
async function popplerPages(
  data: Uint8Array,
  onlyPage?: number,
  onPage?: (page: SourcePage) => void,
): Promise<SourcePage[]> {
  const dir = await mkdtemp(join(tmpdir(), 'venue-plan-'));
  try {
    const input = join(dir, 'source.pdf');
    await writeFile(input, data);
    const info = await execute('pdfinfo', [input], { timeout: 30_000, maxBuffer: 1_000_000 });
    const count = Number(info.stdout.match(/^Pages:\s*(\d+)/m)?.[1]);
    if (!count || count > 50) throw new Error('PDF page limit exceeded or page count unavailable.');
    const pages: SourcePage[] = [];
    for (let n = onlyPage ?? 1; n <= (onlyPage ?? count); n++) {
      const prefix = join(dir, `page-${n}`);
      await execute(
        'pdftoppm',
        [
          '-f',
          String(n),
          '-l',
          String(n),
          '-singlefile',
          '-scale-to',
          '4000',
          '-png',
          input,
          prefix,
        ],
        { timeout: 90_000, maxBuffer: 1_000_000 },
      );
      const image = await loadImage(await readFile(prefix + '.png'));
      const canvas = createCanvas(image.width, image.height);
      canvas.getContext('2d').drawImage(image, 0, 0);
      const page: SourcePage = {
        number: n,
        width: image.width,
        height: image.height,
        preview: canvas.toDataURL('image/png'),
        texts: [],
        lines: [],
        fills: [],
        format: 'pdf-scan',
        unitMetres: null,
        warnings: ['An alternate PDF renderer was used; review image-based boundaries and scale.'],
      };
      await readRaster(page, canvas).catch((error) =>
        page.warnings.push(
          `Automatic detection incomplete: ${error.message}. Trace the hall on the original page.`,
        ),
      );
      pages.push(page);
      onPage?.(page);
    }
    return pages;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
