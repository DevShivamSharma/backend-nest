/**
 * The drawing model every hall-plan format is read into, so one analysis serves DXF and PDF.
 *
 * Coordinates are the drawing's own units with Y UP (CAD convention); the PDF reader flips its
 * page coordinates into the same orientation. `metresPerUnit` converts to metres. Everything is
 * already in world coordinates: DXF block references are expanded while reading.
 */

export interface CadPolyline {
  layer: string;
  /** `#rrggbb`, or null when the colour could not be resolved. */
  color: string | null;
  /** Flat [x0, y0, x1, y1, ...]. */
  points: number[];
  closed: boolean;
}

export interface CadText {
  layer: string;
  /** Plain text: formatting codes removed, paragraph breaks turned into spaces. */
  text: string;
  /** Estimated CENTRE of the text. */
  x: number;
  y: number;
  height: number;
}

/** A block reference, kept after expansion so symbols can be recognised by block name. */
export interface CadInsert {
  layer: string;
  block: string;
  x: number;
  y: number;
  /** Degrees, counter-clockwise (CAD convention). */
  rotation: number;
  /** Rough size of the block's contents in drawing units (0 when unknown). */
  size: number;
}

/** A filled area: a DXF HATCH or SOLID, or a filled PDF path. */
export interface CadFill {
  layer: string;
  color: string | null;
  loops: number[][];
}

export interface CadDrawing {
  format: 'dxf' | 'pdf';
  /** Metres per drawing unit; null when the file does not say. */
  metresPerUnit: number | null;
  /** How the scale was found, for the review screen. */
  scaleSource: string;
  /** Physical cell size from the plan's printed grid note, in metres. */
  gridCell?: { width: number; height: number };
  polylines: CadPolyline[];
  texts: CadText[];
  inserts: CadInsert[];
  fills: CadFill[];
  layers: string[];
  /**
   * Plotted sheets (DXF paper space), read separately from the plan: the legend often sits in
   * the title block. Their coordinates are unrelated to the plan's.
   */
  sheets?: Array<{ texts: CadText[]; fills: CadFill[]; polylines?: CadPolyline[] }>;
  /** Hatch drawn as strokes (PDF), per `#rrggbb` colour: flat [x1, y1, x2, y2, ...]. */
  hatchStrokes?: Record<string, number[]>;
  /** Problems met while reading (skipped entities, limits reached). */
  warnings: string[];
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boxOf(points: number[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function boxContains(box: Box, x: number, y: number, margin = 0): boolean {
  return (
    x >= box.minX - margin &&
    x <= box.maxX + margin &&
    y >= box.minY - margin &&
    y <= box.maxY + margin
  );
}

/** Absolute shoelace area of a closed flat polygon. */
export function polygonArea(points: number[]): number {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    sum += points[i] * points[j + 1] - points[j] * points[i + 1];
  }
  return Math.abs(sum) / 2;
}

export function pointInPolygon(x: number, y: number, points: number[]): boolean {
  let inside = false;
  const n = points.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = points[i];
    const yi = points[i + 1];
    const xj = points[j];
    const yj = points[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to the segment a-b. */
export function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { distance: number; x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { distance: Math.hypot(px - x, py - y), x, y };
}

/**
 * Douglas-Peucker simplification of a closed ring (flat), dropping vertices that deviate less
 * than `tolerance`. Keeps at least three vertices.
 */
export function simplifyRing(points: number[], tolerance: number): number[] {
  const n = points.length / 2;
  if (n <= 3) return points.slice();
  const keep = new Uint8Array(n);
  // Split the ring at its two farthest-apart vertices so both halves are open polylines.
  let far = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(points[2 * i] - points[0], points[2 * i + 1] - points[1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  keep[0] = keep[far] = 1;
  const stack: Array<[number, number]> = [
    [0, far],
    [far, n],
  ];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const bi = b % n;
    let index = -1;
    let max = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(
        points[2 * i],
        points[2 * i + 1],
        points[2 * a],
        points[2 * a + 1],
        points[2 * bi],
        points[2 * bi + 1],
      ).distance;
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (index >= 0) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[2 * i], points[2 * i + 1]);
  return out.length >= 6 ? out : points.slice(0, 6);
}

/** Drops a repeated closing vertex and consecutive duplicates. */
export function cleanRing(points: number[], epsilon: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    const n = out.length;
    if (n && Math.abs(out[n - 2] - x) <= epsilon && Math.abs(out[n - 1] - y) <= epsilon) continue;
    out.push(x, y);
  }
  while (
    out.length >= 4 &&
    Math.abs(out[0] - out[out.length - 2]) <= epsilon &&
    Math.abs(out[1] - out[out.length - 1]) <= epsilon
  ) {
    out.length -= 2;
  }
  return out;
}

/** True when no two non-adjacent edges of the ring cross. O(n²), for rings of modest size. */
export function isSimpleRing(points: number[]): boolean {
  const n = points.length / 2;
  const cross = (i: number, j: number): boolean => {
    const [ax, ay, bx, by] = [
      points[2 * i],
      points[2 * i + 1],
      points[2 * ((i + 1) % n)],
      points[2 * ((i + 1) % n) + 1],
    ];
    const [cx, cy, dx, dy] = [
      points[2 * j],
      points[2 * j + 1],
      points[2 * ((j + 1) % n)],
      points[2 * ((j + 1) % n) + 1],
    ];
    const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
      Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
    return (
      o(ax, ay, bx, by, cx, cy) * o(ax, ay, bx, by, dx, dy) < 0 &&
      o(cx, cy, dx, dy, ax, ay) * o(cx, cy, dx, dy, bx, by) < 0
    );
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (cross(i, j)) return false;
    }
  }
  return true;
}

/** Removes MTEXT/TEXT formatting codes and control sequences, leaving readable text. */
export function plainText(raw: string): string {
  return raw
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\P/g, ' ')
    .replace(/\\[lLoOkKnN]/g, '')
    .replace(/\\[ACFHQTWfhcpqtw][^;\\]*;/g, '')
    .replace(/\\S([^;]*);/g, (_, s: string) => s.replace(/[#^/]/g, '/'))
    .replace(/\\~/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/[{}]/g, '')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/%%\d{3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
