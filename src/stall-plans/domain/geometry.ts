import * as clip from 'polygon-clipping';
import type { MultiPolygon, Point } from './plan.types';

export function rectangle(x: number, y: number, width: number, height: number): MultiPolygon {
  return [
    [
      [
        [x, y],
        [x + width, y],
        [x + width, y + height],
        [x, y + height],
        [x, y],
      ],
    ],
  ];
}
export function bounds(g: MultiPolygon) {
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const poly of g)
    for (const ring of poly)
      for (const p of ring) {
        x = Math.min(x, p[0]);
        y = Math.min(y, p[1]);
        right = Math.max(right, p[0]);
        bottom = Math.max(bottom, p[1]);
      }
  return { x, y, width: right - x, height: bottom - y };
}
export function ringArea(r: Point[]): number {
  return (
    Math.abs(
      r.reduce((s, p, i) => {
        const q = r[(i + 1) % r.length];
        return s + p[0] * q[1] - q[0] * p[1];
      }, 0),
    ) / 2
  );
}
export function area(g: MultiPolygon): number {
  return g.reduce(
    (s, p) => s + ringArea(p[0]) - p.slice(1).reduce((a, r) => a + ringArea(r), 0),
    0,
  );
}
export function union(...items: MultiPolygon[]): MultiPolygon {
  const nonempty = items.filter((g) => g.length);
  return nonempty.length ? (clip.union(nonempty[0], ...nonempty.slice(1)) as MultiPolygon) : [];
}
export function difference(a: MultiPolygon, ...b: MultiPolygon[]): MultiPolygon {
  return a.length && b.some((g) => g.length)
    ? (clip.difference(a, ...b.filter((g) => g.length)) as MultiPolygon)
    : a;
}
export function intersection(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  return a.length && b.length ? (clip.intersection(a, b) as MultiPolygon) : [];
}
export function transform(g: MultiPolygon, fn: (p: Point) => Point): MultiPolygon {
  return g.map((p) => p.map((r) => r.map(fn)));
}
export function inside(p: Point, g: MultiPolygon): boolean {
  const inRing = (r: Point[]) => {
    let yes = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i],
        b = r[j];
      if (
        a[1] > p[1] !== b[1] > p[1] &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        yes = !yes;
    }
    return yes;
  };
  return g.some((poly) => inRing(poly[0]) && !poly.slice(1).some(inRing));
}
export function geometryProblems(g: unknown): string[] {
  if (!Array.isArray(g) || !g.length || g.length > 500)
    return ['A boundary needs at least one polygon (maximum 500).'];
  let vertices = 0;
  for (const poly of g) {
    if (!Array.isArray(poly) || !poly.length) return ['A polygon needs an outer ring.'];
    for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 4)
        return ['Each ring needs at least three corners and a closing point.'];
      vertices += ring.length;
      if (vertices > 20000 || ring.length > 2000) return ['The boundary has too many vertices.'];
      if (
        ring.some(
          (p: unknown) =>
            !Array.isArray(p) ||
            p.length !== 2 ||
            p.some(
              (v: unknown) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e7,
            ),
        )
      )
        return ['Coordinates must be finite numbers.'];
      if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])
        return ['Close every polygon ring.'];
      if (ringArea(ring) < 1e-8) return ['A polygon has no area.'];
      for (let i = 0; i < ring.length - 1; i++)
        for (let j = i + 2; j < ring.length - 1; j++) {
          if (i === 0 && j === ring.length - 2) continue;
          const cross = (a: Point, b: Point, c: Point) =>
            (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          if (
            cross(ring[i], ring[i + 1], ring[j]) * cross(ring[i], ring[i + 1], ring[j + 1]) < 0 &&
            cross(ring[j], ring[j + 1], ring[i]) * cross(ring[j], ring[j + 1], ring[i + 1]) < 0
          )
            return ['A boundary crosses itself.'];
        }
    }
    for (const hole of poly.slice(1))
      if (hole.slice(0, -1).some((p: Point) => !inside(p, [[poly[0]]])))
        return ['A hole extends outside its boundary.'];
  }
  try {
    if (area(g as MultiPolygon) <= 0) return ['The boundary must enclose positive area.'];
    union(g as MultiPolygon);
  } catch {
    return ['The boundary cannot be processed.'];
  }
  return [];
}
export const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Exact decomposition for orthogonal polygons, including holes; null means a polygon renderer is required. */
export function orthogonalRectangles(
  g: MultiPolygon,
): { x: number; y: number; width: number; height: number }[] | null {
  for (const poly of g)
    for (const ring of poly)
      for (let i = 1; i < ring.length; i++)
        if (
          Math.abs(ring[i][0] - ring[i - 1][0]) > 1e-7 &&
          Math.abs(ring[i][1] - ring[i - 1][1]) > 1e-7
        )
          return null;
  const ys = [...new Set(g.flat(2).map((p) => p[1]))].sort((a, b) => a - b),
    out: { x: number; y: number; width: number; height: number }[] = [];
  let previous = new Map<string, number>();
  for (let i = 1; i < ys.length; i++) {
    const y = ys[i - 1],
      height = ys[i] - y,
      mid = y + height / 2,
      hits: number[] = [];
    for (const poly of g)
      for (const ring of poly)
        for (let j = 1; j < ring.length; j++) {
          const a = ring[j - 1],
            b = ring[j];
          if ((a[1] <= mid && b[1] > mid) || (b[1] <= mid && a[1] > mid)) hits.push(a[0]);
        }
    hits.sort((a, b) => a - b);
    const current = new Map<string, number>();
    for (let j = 1; j < hits.length; j += 2) {
      const x = hits[j - 1],
        width = hits[j] - x;
      if (width < 1e-7) continue;
      const key = `${x}:${width}`,
        old = previous.get(key);
      if (old !== undefined) {
        out[old].height += height;
        current.set(key, old);
      } else {
        current.set(key, out.length);
        out.push({ x, y, width, height });
      }
      if (out.length > 10000) return null;
    }
    previous = current;
  }
  return out;
}
