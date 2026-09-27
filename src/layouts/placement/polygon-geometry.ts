import { difference, intersection, type MultiPolygon, type Polygon } from 'polygon-clipping';
import type { Footprint, Point } from './placement-rules';

export const EPS = 1e-6;
export const ring = (p: Point[]): Polygon => [[...p, p[0]].map((v) => [v.x, v.z])];
export const edges = (p: Point[]): [Point, Point][] => p.map((a, i) => [a, p[(i + 1) % p.length]]);
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, z: a.z - b.z });
export const dot = (a: Point, b: Point): number => a.x * b.x + a.z * b.z;
export function area(p: MultiPolygon): number {
  return p.reduce(
    (total, poly) =>
      total +
      poly.reduce((sum, r, i) => {
        const a =
          Math.abs(
            r.reduce((s, v, j) => {
              const w = r[(j + 1) % r.length];
              // Translate to a local origin before the cross product: global coordinates
              // can otherwise cancel a small, real intersection to zero.
              return s + (v[0] - r[0][0]) * (w[1] - r[0][1]) - (v[1] - r[0][1]) * (w[0] - r[0][0]);
            }, 0),
          ) / 2;
        return sum + (i === 0 ? a : -a);
      }, 0),
    0,
  );
}
export function overlaps(a: Point[], b: Point[]): boolean {
  // Most stall pairs are far apart. Avoid polygon clipping for disjoint bounding boxes;
  // overlapping bounds still go through exact polygon intersection below.
  for (const axis of ['x', 'z'] as const) {
    if (
      Math.max(...a.map((p) => p[axis])) <= Math.min(...b.map((p) => p[axis])) ||
      Math.max(...b.map((p) => p[axis])) <= Math.min(...a.map((p) => p[axis]))
    )
      return false;
  }
  return area(intersection(ring(a), ring(b))) > EPS * EPS;
}
export function contained(p: Point[], floor: MultiPolygon): boolean {
  return area(difference(ring(p), floor)) <= EPS * EPS;
}
export function rotate(p: Point, degrees: number): Point {
  const t = ((degrees % 360) * Math.PI) / 180;
  return { x: p.x * Math.cos(t) - p.z * Math.sin(t), z: p.x * Math.sin(t) + p.z * Math.cos(t) };
}
export function stallPolygon(f: Footprint): Point[] {
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([x, z]) => {
    const p = rotate({ x: (x * f.width) / 2, z: (z * f.length) / 2 }, f.rotation ?? 0);
    return { x: p.x + f.posX, z: p.z + f.posZ };
  });
}
/** Reject finite inputs whose derived edges collapse or overflow in double precision. */
export function isRepresentableFootprint(f: Footprint): boolean {
  if (
    ![f.width, f.length, f.posX, f.posZ, f.rotation ?? 0, f.width * f.length].every(
      Number.isFinite,
    ) ||
    f.width <= 0 ||
    f.length <= 0
  )
    return false;
  const p = stallPolygon(f);
  return (
    p.every((v) => Number.isFinite(v.x) && Number.isFinite(v.z)) &&
    edges(p).every(([a, b], i) => {
      const actual = Math.hypot(b.x - a.x, b.z - a.z);
      const expected = i % 2 === 0 ? f.width : f.length;
      return actual > 0 && Number.isFinite(actual) && Math.abs(actual - expected) <= EPS;
    })
  );
}
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return Math.hypot(p.x - a.x - t * ab.x, p.z - a.z - t * ab.z);
}
export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  const cross = (u: Point, v: Point) => u.x * v.z - u.z * v.x;
  const ab = sub(b, a),
    cd = sub(d, c),
    ac = sub(c, a);
  const den = cross(ab, cd);
  if (Math.abs(den) > EPS * EPS) {
    const t = cross(ac, cd) / den,
      u = cross(ac, ab) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}
export function distance(a: Point[], b: Point[]): number {
  return Math.min(
    ...edges(a).flatMap(([p, q]) => edges(b).map(([r, s]) => segmentDistance(p, q, r, s))),
  );
}
/** The complete interstitial region joining two convex footprints must be usable floor. */
export function gapInsideFloor(a: Point[], b: Point[], floor: MultiPolygon): boolean {
  const points = [...a, ...b].sort((p, q) => p.x - q.x || p.z - q.z);
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const half = (ps: Point[]) => {
    const hull: Point[] = [];
    for (const p of ps) {
      while (hull.length >= 2) {
        const a = hull[hull.length - 2],
          b = hull[hull.length - 1];
        const tolerance =
          EPS *
          EPS *
          Math.max(1, Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(p.x - a.x, p.z - a.z));
        if (cross(a, b, p) > tolerance) break;
        hull.pop();
      }
      hull.push(p);
    }
    return hull.slice(0, -1);
  };
  const hull = [...half(points), ...half([...points].reverse())];
  // Footprints are independently required to be inside the floor. Checking the hull
  // therefore checks the same gap without constructing coincident cut edges twice.
  return contained(hull, floor);
}
export const sideIndexes: Record<string, number> = { BACK: 0, RIGHT: 1, FRONT: 2, LEFT: 3 };
export function normal(p: Point[], side: number): Point {
  const a = p[side],
    b = p[(side + 1) % 4],
    size = Math.hypot(b.x - a.x, b.z - a.z);
  return { x: (b.z - a.z) / size, z: -(b.x - a.x) / size };
}
export function corridor(p: Point[], side: number, width: number): Point[] {
  const a = p[side],
    b = p[(side + 1) % 4],
    n = normal(p, side);
  return [
    a,
    b,
    { x: b.x + n.x * width, z: b.z + n.z * width },
    { x: a.x + n.x * width, z: a.z + n.z * width },
  ];
}
export function openSides(f: Footprint): string[] {
  return f.openSides?.length ? f.openSides : [f.gateSide ?? 'FRONT'];
}
/** Positive-length shared edge; the single open normals must point away from it. */
export function backToBack(a: Footprint, b: Footprint): boolean {
  const ap = stallPolygon(a),
    bp = stallPolygon(b),
    as = openSides(a),
    bs = openSides(b);
  if (as.length !== 1 || bs.length !== 1) return false;
  const an = normal(ap, sideIndexes[as[0]]),
    bn = normal(bp, sideIndexes[bs[0]]);
  if (dot(an, bn) > -1 + EPS) return false;
  return edges(ap).some(([p, q], i) =>
    edges(bp).some(([r, s], j) => {
      const tangent = sub(q, p),
        len = Math.hypot(tangent.x, tangent.z);
      const unit = { x: tangent.x / len, z: tangent.z / len };
      const n = normal(ap, i);
      if (dot(n, normal(bp, j)) > -1 + EPS || dot(an, n) > -1 + EPS) return false;
      if (Math.abs(dot(sub(r, p), n)) > EPS || Math.abs(dot(sub(s, p), n)) > EPS) return false;
      const lo = Math.min(dot(sub(r, p), unit), dot(sub(s, p), unit));
      const hi = Math.max(dot(sub(r, p), unit), dot(sub(s, p), unit));
      return Math.min(len, hi) - Math.max(0, lo) > EPS;
    }),
  );
}
