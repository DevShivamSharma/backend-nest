import DxfParser from 'dxf-parser';

import { PdfReadError, type PageVectors, type TextSpan, type VectorPath } from '../cad/pdf-vectors';

/** Row-major 2D affine transform [a, b, c, d, tx, ty]: x' = a·x + c·y + tx, y' = b·x + d·y + ty. */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const MAX_BLOCK_DEPTH = 8;
/** Curves are cut into this many segments per full turn. */
const ARC_STEPS = 48;

interface Layer {
  color: number | null;
}

/**
 * A DXF drawing (ASCII), read into the page model the stall extraction works on: lines per layer
 * with their colour, and texts. DXF draws y up and the extraction reads a displayed page (y down),
 * so y is flipped about the drawing's top. Block references are expanded. Units are kept as they
 * are: the extraction works from the stall grid's own pitch, not from absolute sizes.
 */
export function dxfToVectors(text: string): PageVectors {
  let doc: ReturnType<DxfParser['parseSync']>;
  try {
    doc = new DxfParser().parseSync(text);
  } catch (e) {
    throw new PdfReadError(`Not a readable DXF: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!doc) throw new PdfReadError('Not a readable DXF: use an ASCII DXF export.');

  const layerTable = (doc.tables?.layer?.layers ?? {}) as Record<string, Layer>;
  const layerColor = (name: string) => layerTable[name]?.color ?? null;
  const paths = new Map<string, VectorPath>();
  const texts: TextSpan[] = [];

  const stroke = (
    layer: string,
    entityColor: number | undefined,
    byLayer: boolean,
  ): string | null => {
    const rgb = byLayer || entityColor === undefined ? layerColor(layer) : entityColor;
    return rgb === null || rgb === undefined ? null : '#' + rgb.toString(16).padStart(6, '0');
  };

  const addSegments = (
    layer: string,
    color: string | null,
    points: Array<{ x: number; y: number }>,
    closed: boolean,
    m: Matrix,
  ): void => {
    const key = `${layer}|${color ?? ''}`;
    let path = paths.get(key);
    if (!path) {
      path = { layer, stroke: color, fill: null, width: 0, segments: [] };
      paths.set(key, path);
    }
    const p = points.map((v) => apply(m, v.x, v.y));
    for (let i = 1; i < p.length; i++) {
      path.segments.push({ x1: p[i - 1][0], y1: p[i - 1][1], x2: p[i][0], y2: p[i][1] });
    }
    if (closed && p.length > 2) {
      const last = p[p.length - 1];
      path.segments.push({ x1: last[0], y1: last[1], x2: p[0][0], y2: p[0][1] });
    }
  };

  const walk = (entities: DxfEntity[], m: Matrix, depth: number): void => {
    if (depth > MAX_BLOCK_DEPTH) return;
    for (const e of entities) {
      const layer = e.layer || '0';
      const color = stroke(layer, e.color, e.colorIndex === 256 || e.colorIndex === undefined);
      switch (e.type) {
        case 'LINE':
        case 'LWPOLYLINE':
        case 'POLYLINE':
          addSegments(layer, color, e.vertices ?? [], !!e.shape, m);
          break;
        case 'CIRCLE':
        case 'ARC': {
          const a = e.type === 'ARC' ? (e.startAngle ?? 0) : 0;
          const b = e.type === 'ARC' ? (e.endAngle ?? Math.PI * 2) : Math.PI * 2;
          const span = (((b - a) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
          const steps = Math.max(4, Math.ceil((ARC_STEPS * span) / (Math.PI * 2)));
          const centre = e.center ?? { x: 0, y: 0 };
          const pts = Array.from({ length: steps + 1 }, (_, i) => ({
            x: centre.x + (e.radius ?? 0) * Math.cos(a + (span * i) / steps),
            y: centre.y + (e.radius ?? 0) * Math.sin(a + (span * i) / steps),
          }));
          addSegments(layer, color, pts, false, m);
          break;
        }
        case 'TEXT':
        case 'MTEXT': {
          const at = e.endPoint ?? e.startPoint ?? e.position;
          const raw = String(e.text ?? '');
          const clean = raw
            .replace(/\\P/g, ' ')
            .replace(/\\[A-Za-z][^;]*;/g, '')
            .replace(/[{}]/g, '')
            .trim();
          if (!at || !clean) break;
          const [x, y] = apply(m, at.x, at.y);
          const size = Math.abs((e.textHeight ?? e.height ?? 1) * Math.hypot(m[0], m[1]));
          const turn = (((e.rotation ?? 0) % 180) + 180) % 180;
          texts.push({ text: clean, x, y, size, vertical: Math.abs(turn - 90) < 1 });
          break;
        }
        case 'INSERT': {
          const block = doc.blocks?.[e.name ?? ''];
          if (!block?.entities?.length) break;
          const angle = ((e.rotation ?? 0) * Math.PI) / 180;
          const sx = e.xScale ?? 1;
          const sy = e.yScale ?? 1;
          const at = e.position ?? { x: 0, y: 0 };
          const base = block.position ?? { x: 0, y: 0 };
          const local: Matrix = [
            Math.cos(angle) * sx,
            Math.sin(angle) * sx,
            -Math.sin(angle) * sy,
            Math.cos(angle) * sy,
            at.x - (base.x * Math.cos(angle) * sx - base.y * Math.sin(angle) * sy),
            at.y - (base.x * Math.sin(angle) * sx + base.y * Math.cos(angle) * sy),
          ];
          walk(block.entities as DxfEntity[], multiply(m, local), depth + 1);
          break;
        }
        default:
          break;
      }
    }
  };
  walk((doc.entities ?? []) as DxfEntity[], IDENTITY, 0);

  const list = [...paths.values()].filter((p) => p.segments.length);
  if (!list.length) throw new PdfReadError('The DXF has no lines to read.');

  // y up -> y down about the drawing's top; shift to start at the origin.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const p of list)
    for (const s of p.segments) {
      grow(s.x1, s.y1);
      grow(s.x2, s.y2);
    }
  for (const t of texts) grow(t.x, t.y);
  const flipX = (x: number) => x - minX;
  const flipY = (y: number) => maxY - y;
  for (const p of list)
    p.segments = p.segments.map((s) => ({
      x1: flipX(s.x1),
      y1: flipY(s.y1),
      x2: flipX(s.x2),
      y2: flipY(s.y2),
    }));
  for (const t of texts) {
    t.x = flipX(t.x);
    t.y = flipY(t.y);
  }

  return {
    width: maxX - minX,
    height: maxY - minY,
    rotation: 0,
    paths: list,
    texts,
    layers: [...new Set(list.map((p) => p.layer))],
    pageCount: 1,
  };
}

/** Whether the bytes are an ASCII DXF (what a CAD program exports), not a binary DXF or a PDF. */
export function isAsciiDxf(buffer: Uint8Array): boolean {
  const head = Buffer.from(buffer.subarray(0, 4096)).toString('latin1');
  return /^\s*0\s*\r?\n\s*SECTION\b/.test(head);
}

type DxfEntity = {
  type: string;
  layer?: string;
  color?: number;
  colorIndex?: number;
  vertices?: Array<{ x: number; y: number }>;
  shape?: boolean;
  center?: { x: number; y: number };
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  text?: string;
  startPoint?: { x: number; y: number };
  endPoint?: { x: number; y: number };
  position?: { x: number; y: number };
  textHeight?: number;
  height?: number;
  rotation?: number;
  name?: string;
  xScale?: number;
  yScale?: number;
};

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function multiply(p: Matrix, q: Matrix): Matrix {
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}
