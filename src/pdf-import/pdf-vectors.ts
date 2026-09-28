/**
 * Reads the vector content of one PDF page: every stroked line with its layer (AutoCAD layers
 * are PDF optional-content groups), colour and width, and every text span. No rendering, no
 * fonts, no scripts: pdf.js runs with `isEvalSupported: false` (the mitigation for advisory
 * GHSA-wgrm-67xf-hhpq), and only its operator list and text content are read.
 *
 * Coordinates are page points in DISPLAY orientation (x right, y down, page rotation applied),
 * i.e. how the drawing looks when opened.
 */

// pdf.js 3.x ships a CommonJS "legacy" build, which runs in Node and under Jest as-is.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js') as PdfJs;

export interface VectorSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface VectorPath {
  /** Optional-content (layer) name, '' when the path is on no layer. */
  layer: string;
  /** `#rrggbb` of the stroke, or null. */
  stroke: string | null;
  fill: string | null;
  /** Line width in page points. */
  width: number;
  segments: VectorSegment[];
}

export interface TextSpan {
  text: string;
  /** Centre of the span, display points. */
  x: number;
  y: number;
  /** Font size in points. */
  size: number;
  /** True when the text runs vertically on the displayed page. */
  vertical: boolean;
}

export interface PageVectors {
  /** Displayed page size in points. */
  width: number;
  height: number;
  rotation: number;
  paths: VectorPath[];
  texts: TextSpan[];
  /** Layer names present on the page (optional-content groups). */
  layers: string[];
  pageCount: number;
}

export class PdfReadError extends Error {}

/** Maximum operator count read from one page; a denial-of-service guard, far above real plans. */
const MAX_OPERATORS = 5_000_000;

export async function readPageVectors(data: Uint8Array, pageNumber = 1): Promise<PageVectors> {
  let doc: PdfDocument;
  try {
    doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      verbosity: 0,
    }).promise;
  } catch (e) {
    throw new PdfReadError(`Not a readable PDF: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    if (pageNumber < 1 || pageNumber > doc.numPages) {
      throw new PdfReadError(`The PDF has no page ${pageNumber}.`);
    }
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const oc = await doc.getOptionalContentConfig();
    const layerName = (id: string): string => oc?.getGroup?.(id)?.name ?? '';

    const ops = await page.getOperatorList();
    if (ops.fnArray.length > MAX_OPERATORS) {
      throw new PdfReadError('The PDF page is too complex to import.');
    }
    const O = pdfjs.OPS;

    // Graphics state stack: CTM, colours, width.
    type State = { ctm: number[]; stroke: string | null; fill: string | null; width: number };
    let state: State = { ctm: viewport.transform.slice(), stroke: '#000000', fill: '#000000', width: 1 };
    const stack: State[] = [];
    const layers: string[] = [];
    const paths: VectorPath[] = [];
    let pending: VectorSegment[] | null = null;

    const apply = (m: number[], x: number, y: number): [number, number] => [
      m[0] * x + m[2] * y + m[4],
      m[1] * x + m[3] * y + m[5],
    ];
    const scaleOf = (m: number[]) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i] as unknown[];
      switch (fn) {
        case O.save:
          stack.push({ ...state, ctm: state.ctm.slice() });
          break;
        case O.restore:
          state = stack.pop() ?? state;
          break;
        case O.transform:
          state.ctm = multiply(state.ctm, args as number[]);
          break;
        case O.setLineWidth:
          state.width = Number(args[0]) || 0;
          break;
        case O.setStrokeRGBColor:
          state.stroke = hex(args);
          break;
        case O.setFillRGBColor:
          state.fill = hex(args);
          break;
        case O.beginMarkedContentProps: {
          const props = args[1] as { type?: string; id?: string } | null;
          layers.push(args[0] === 'OC' && props?.id ? layerName(props.id) : (layers[layers.length - 1] ?? ''));
          break;
        }
        case O.beginMarkedContent:
          layers.push(layers[layers.length - 1] ?? '');
          break;
        case O.endMarkedContent:
          layers.pop();
          break;
        case O.constructPath:
          pending = pathSegments(args as [number[], number[]], state.ctm, apply, O);
          break;
        case O.stroke:
        case O.closeStroke:
        case O.fillStroke:
        case O.eoFillStroke:
        case O.closeFillStroke:
        case O.closeEOFillStroke:
        case O.fill:
        case O.eoFill:
          if (pending?.length) {
            const stroked = fn !== O.fill && fn !== O.eoFill;
            const filled = fn !== O.stroke && fn !== O.closeStroke;
            paths.push({
              layer: layers[layers.length - 1] ?? '',
              stroke: stroked ? state.stroke : null,
              fill: filled ? state.fill : null,
              width: stroked ? state.width * scaleOf(state.ctm) : 0,
              segments: pending,
            });
          }
          pending = null;
          break;
        case O.endPath:
          pending = null;
          break;
        default:
          break;
      }
    }

    const texts: TextSpan[] = [];
    const content = await page.getTextContent();
    for (const item of content.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>) {
      const text = (item.str ?? '').trim();
      if (!text || !item.transform) continue;
      const m = multiply(viewport.transform, item.transform);
      // Text runs along the matrix's x axis; its centre is half the width along it and half
      // the height up (text space y is up).
      const w = item.width ?? 0;
      const size = Math.hypot(item.transform[2], item.transform[3]) || item.height || 0;
      const ux = Math.hypot(item.transform[0], item.transform[1]) || 1;
      const [cx, cy] = apply(m, w / 2 / ux, 0.35);
      const dir = [m[0], m[1]];
      texts.push({ text, x: cx, y: cy, size, vertical: Math.abs(dir[1]) > Math.abs(dir[0]) });
    }

    const groups = oc?.getGroups?.() ?? {};
    return {
      width: viewport.width,
      height: viewport.height,
      rotation: page.rotate ?? 0,
      paths,
      texts,
      layers: Object.values(groups).map((g) => g.name ?? ''),
      pageCount: doc.numPages,
    };
  } finally {
    await doc.destroy();
  }
}

function pathSegments(
  args: [number[], number[]],
  ctm: number[],
  apply: (m: number[], x: number, y: number) => [number, number],
  O: PdfJs['OPS'],
): VectorSegment[] {
  const [ops, coords] = args;
  const out: VectorSegment[] = [];
  let k = 0;
  let cur: [number, number] | null = null;
  let start: [number, number] | null = null;
  const lineTo = (p: [number, number]) => {
    if (cur) out.push({ x1: cur[0], y1: cur[1], x2: p[0], y2: p[1] });
    cur = p;
  };
  for (const op of ops) {
    if (op === O.moveTo) {
      cur = apply(ctm, coords[k], coords[k + 1]);
      start = cur;
      k += 2;
    } else if (op === O.lineTo) {
      lineTo(apply(ctm, coords[k], coords[k + 1]));
      k += 2;
    } else if (op === O.curveTo) {
      // Curves only matter as their chord here (stall outlines are straight).
      lineTo(apply(ctm, coords[k + 4], coords[k + 5]));
      k += 6;
    } else if (op === O.curveTo2 || op === O.curveTo3) {
      lineTo(apply(ctm, coords[k + 2], coords[k + 3]));
      k += 4;
    } else if (op === O.rectangle) {
      const [x, y, w, h] = coords.slice(k, k + 4);
      const p = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)];
      for (let j = 0; j < 4; j++) {
        out.push({ x1: p[j][0], y1: p[j][1], x2: p[(j + 1) % 4][0], y2: p[(j + 1) % 4][1] });
      }
      k += 4;
      cur = null;
    } else if (op === O.closePath) {
      if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) lineTo(start);
      cur = start;
    }
  }
  return out;
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

/**
 * pdf.js passes an RGB colour as its argument list: three bytes (a Uint8ClampedArray in 3.x), or
 * in some builds a single `#rrggbb` string or a one-element array holding the bytes.
 */
function hex(args: unknown): string {
  const list = args as ArrayLike<unknown>;
  if (typeof list?.[0] === 'string') return (list[0] as string).toLowerCase();
  const bytes = typeof list?.[0] === 'object' && list[0] !== null ? (list[0] as ArrayLike<number>) : (list as ArrayLike<number>);
  const rgb = [bytes?.[0], bytes?.[1], bytes?.[2]].map((v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))));
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// --- minimal pdf.js typing for what is used here -------------------------------------------------

interface PdfJs {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocument> };
  OPS: Record<string, number>;
}

interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  getOptionalContentConfig(): Promise<{
    getGroup?(id: string): { name?: string } | null;
    getGroups?(): Record<string, { name?: string }> | null;
  } | null>;
  destroy(): Promise<void>;
}

interface PdfPage {
  rotate?: number;
  getViewport(o: { scale: number }): { width: number; height: number; transform: number[] };
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  getTextContent(): Promise<{ items: unknown[] }>;
}
