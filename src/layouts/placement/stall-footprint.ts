import type { Point } from './placement-rules';

/**
 * Polygon stall footprints ("custom" stalls: L-shapes and other closed, possibly concave outlines).
 *
 * A rectangular stall has no footprint: it is `width x length` around (posX, posZ), exactly as
 * before. A custom stall carries `footprint`, its outline in LOCAL metres before rotation, and
 * `openEdges`, the indices of the edges left open for customers (edge i runs from vertex i to
 * vertex i + 1). The stall stays ONE object: one id, one number, one polygon. Its notch is not
 * part of it, so collision, containment and passage checks use the real outline.
 *
 * Canonical form, produced by `normalizeFootprint`, so every consumer can rely on it:
 *   - local frame as for rectangles: X right, Z down the plan (front = +Z);
 *   - clockwise on the plan (positive shoelace sum in X-right / Z-down), like the rectangle
 *     corner order used by `stallPolygon`, so an edge's outward normal is (dz, -dx) / |edge|;
 *   - centred on its bounding box, so `width` / `length` are the bounding box and (posX, posZ)
 *     is its centre, the same meaning those fields have for a rectangle;
 *   - no repeated or collinear vertices, no self-intersection, at most MAX_FOOTPRINT_VERTICES.
 */

export const MAX_FOOTPRINT_VERTICES = 64;
const EPS = 1e-6;

export interface NormalizedFootprint {
  /** Canonical outline, centred on its bounding box. */
  points: Point[];
  /** Bounding box size. */
  width: number;
  length: number;
  /** Where the bounding-box centre was in the input's frame (add to posX/posZ when re-centring). */
  offset: Point;
  /** Maps an input edge index to its canonical index (reversal and dropped vertices renumber). */
  edgeMap: Map<number, number>;
}

/** Signed shoelace sum / 2 in X-right / Z-down: positive = clockwise on the plan. */
export function signedArea(p: Point[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a.x * b.z - b.x * a.z;
  }
  return s / 2;
}

export function polygonArea(p: Point[]): number {
  return Math.abs(signedArea(p));
}

/**
 * Validates and canonicalises an outline. Returns a reason string instead of throwing, so the
 * caller decides how to report it (HTTP 400, review item in the PDF import...).
 */
export function normalizeFootprint(raw: unknown): NormalizedFootprint | string {
  if (!Array.isArray(raw)) return 'Footprint must be a list of points.';
  const input: Point[] = [];
  for (const v of raw) {
    const p = v as { x?: unknown; z?: unknown } | null;
    if (!p || typeof p.x !== 'number' || typeof p.z !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.z)) {
      return 'Footprint points must have finite numeric x and z.';
    }
    input.push({ x: p.x, z: p.z });
  }
  if (input.length > MAX_FOOTPRINT_VERTICES) {
    return `Footprint may have at most ${MAX_FOOTPRINT_VERTICES} points.`;
  }

  // Drop a closing duplicate, repeated and collinear vertices, remembering which input edge
  // each surviving edge continues so open edges can be carried over.
  let pts = input.map((p, i) => ({ ...p, edge: i }));
  if (pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts = pts.slice(0, -1);
  for (let changed = true; changed && pts.length >= 3; ) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const cur = pts[i];
      const next = pts[(i + 1) % pts.length];
      const cross = (cur.x - prev.x) * (next.z - cur.z) - (cur.z - prev.z) * (next.x - cur.x);
      if (same(prev, cur) || Math.abs(cross) <= EPS * Math.max(1, dist(prev, cur) * dist(cur, next))) {
        // `cur` is redundant: the edge prev->cur and cur->next merge into prev's edge.
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (pts.length < 3) return 'Footprint needs at least 3 distinct, non-collinear points.';
  if (selfIntersects(pts)) return 'Footprint edges must not cross each other.';
  const area = signedArea(pts);
  if (Math.abs(area) <= EPS) return 'Footprint area must be greater than 0.';

  // Orientation: clockwise on the plan. Reversing turns edge i (v_i -> v_i+1) into the edge
  // that ends at the old v_i.
  let oriented = pts.map((p) => ({ x: p.x, z: p.z, edge: p.edge }));
  const edgeMap = new Map<number, number>();
  if (area < 0) {
    const n = oriented.length;
    const reversed = [...oriented].reverse();
    // In the reversed list, canonical edge j runs reversed[j] -> reversed[j+1], i.e. the old
    // edge that started at reversed[j+1].
    oriented = reversed.map((p, j) => ({ x: p.x, z: p.z, edge: reversed[(j + 1) % n].edge }));
  }
  oriented.forEach((p, j) => {
    // Every input edge that was merged into this canonical edge maps to it.
    edgeMap.set(p.edge, j);
  });
  // Input edges swallowed by collinear merging map to the edge that absorbed them.
  for (let i = 0; i < input.length; i++) {
    if (edgeMap.has(i)) continue;
    for (let k = i - 1; k >= i - input.length; k--) {
      const hit = edgeMap.get((k + input.length) % input.length);
      if (hit !== undefined) {
        edgeMap.set(i, hit);
        break;
      }
    }
  }

  const xs = oriented.map((p) => p.x);
  const zs = oriented.map((p) => p.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const offset = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
  return {
    points: oriented.map((p) => ({ x: round(p.x - offset.x), z: round(p.z - offset.z) })),
    width: round(maxX - minX),
    length: round(maxZ - minZ),
    offset,
    edgeMap,
  };
}

/** Open edge indices, deduplicated and restricted to the outline's edges. */
export function normalizeOpenEdges(raw: unknown, vertexCount: number): number[] | string {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return 'openEdges must be a list of edge indices.';
  const out = new Set<number>();
  for (const v of raw) {
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= vertexCount) {
      return `openEdges entries must be edge indices from 0 to ${vertexCount - 1}.`;
    }
    out.add(v as number);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The legacy FRONT/BACK/LEFT/RIGHT summary of a custom stall's open edges (for `gateSide` /
 * `openSides` consumers that do not understand footprints): each open edge's outward normal,
 * snapped to the nearest local side.
 */
export function sidesOfEdges(points: Point[], openEdges: number[]): string[] {
  const sides: string[] = [];
  for (const i of openEdges) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const len = dist(a, b) || 1;
    const n = { x: (b.z - a.z) / len, z: -(b.x - a.x) / len };
    const side =
      Math.abs(n.x) >= Math.abs(n.z) ? (n.x > 0 ? 'RIGHT' : 'LEFT') : n.z > 0 ? 'FRONT' : 'BACK';
    if (!sides.includes(side)) sides.push(side);
  }
  return sides;
}

function same(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= EPS && Math.abs(a.z - b.z) <= EPS;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Any two non-adjacent edges touching or crossing. */
function selfIntersects(p: Point[]): boolean {
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsTouch(a, b, p[j], p[(j + 1) % n])) return true;
    }
  }
  return false;
}

function segmentsTouch(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const on = (p: Point, q: Point, r: Point) =>
    Math.min(p.x, q.x) - EPS <= r.x &&
    r.x <= Math.max(p.x, q.x) + EPS &&
    Math.min(p.z, q.z) - EPS <= r.z &&
    r.z <= Math.max(p.z, q.z) + EPS;
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) {
    return true;
  }
  return (
    (Math.abs(d1) <= EPS && on(c, d, a)) ||
    (Math.abs(d2) <= EPS && on(c, d, b)) ||
    (Math.abs(d3) <= EPS && on(a, b, c)) ||
    (Math.abs(d4) <= EPS && on(a, b, d))
  );
}
