import { boxOf, type Box, type CadPolyline } from './cad-drawing';

/**
 * Hall outlines traced from wall linework.
 *
 * Architectural plans rarely draw a hall as one closed polyline: its walls are hundreds of
 * separate lines, broken by doors and gates. So the walls are rasterised, gaps up to
 * `2 * GAP_METRES` wide are closed (doors, gates, cargo entries), everything reachable from
 * outside is flood-filled away, and the outer contour of what remains is traced. Each separate
 * enclosed area is one outline, so a plan showing several halls yields several.
 */

export interface TracedOutline {
  /** Flat ring in drawing units (y up), not yet simplified. */
  ring: number[];
  box: Box;
  /** Area in m². */
  area: number;
}

/** Half the widest opening that is still closed; the hall's gates can be ~8 m wide. */
const GAP_METRES = 4;
const MAX_CELLS = 3_000_000;
const CLUSTER_METRES = 25;
const MIN_AREA = 150;

export function traceOutlines(
  polylines: CadPolyline[],
  metresPerUnit: number,
  isWall: (layer: string) => boolean,
): TracedOutline[] {
  const segments: number[] = [];
  for (const p of polylines) {
    if (!isWall(p.layer)) continue;
    const n = p.points.length;
    const last = p.closed ? n : n - 2;
    for (let i = 0; i < last; i += 2) {
      const j = (i + 2) % n;
      segments.push(p.points[i], p.points[i + 1], p.points[j], p.points[j + 1]);
    }
  }
  if (!segments.length) return [];

  const out: TracedOutline[] = [];
  for (const box of clusters(segments, CLUSTER_METRES / metresPerUnit).slice(0, 8)) {
    out.push(...traceCluster(segments, box, metresPerUnit));
  }
  return out.sort((a, b) => b.area - a.area);
}

/** Groups the wall segments into separate areas of the drawing (a plan may hold copies far apart). */
function clusters(segments: number[], cell: number): Box[] {
  const cells = new Map<string, number>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (let i = 0; i < segments.length; i += 4) {
    const [x1, y1, x2, y2] = [segments[i], segments[i + 1], segments[i + 2], segments[i + 3]];
    const steps = Math.min(200, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / cell));
    for (let s = 0; s <= steps; s++) {
      const t = steps ? s / steps : 0;
      const k = key(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      cells.set(k, (cells.get(k) ?? 0) + 1);
    }
  }
  const seen = new Set<string>();
  const found: Array<{ box: Box; weight: number }> = [];
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack = [start];
    let [minX, minY, maxX, maxY, weight] = [Infinity, Infinity, -Infinity, -Infinity, 0];
    while (stack.length) {
      const k = stack.pop()!;
      const [cx, cy] = k.split(',').map(Number);
      weight += cells.get(k)!;
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy);
      maxY = Math.max(maxY, cy);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const n = `${cx + dx},${cy + dy}`;
          if (!seen.has(n) && cells.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
    }
    found.push({
      box: { minX: (minX - 1) * cell, minY: (minY - 1) * cell, maxX: (maxX + 2) * cell, maxY: (maxY + 2) * cell },
      weight,
    });
  }
  return found.sort((a, b) => b.weight - a.weight).map((f) => f.box);
}

function traceCluster(segments: number[], box: Box, s: number): TracedOutline[] {
  const widthM = (box.maxX - box.minX) * s;
  const heightM = (box.maxY - box.minY) * s;
  if (Math.max(widthM, heightM) < 15 || Math.max(widthM, heightM) > 1500) return [];
  const res = Math.max(0.2, Math.sqrt((widthM * heightM) / MAX_CELLS)); // metres per cell
  const r = Math.ceil(GAP_METRES / res);
  const pad = r + 2;
  const w = Math.ceil(widthM / res) + 2 * pad;
  const h = Math.ceil(heightM / res) + 2 * pad;
  const unit = res / s; // drawing units per cell
  const gx = (x: number) => Math.floor((x - box.minX) / unit) + pad;
  const gy = (y: number) => Math.floor((box.maxY - y) / unit) + pad; // row 0 = top

  const wall = new Uint8Array(w * h);
  for (let i = 0; i < segments.length; i += 4) {
    const [x1, y1, x2, y2] = [segments[i], segments[i + 1], segments[i + 2], segments[i + 3]];
    if (Math.max(x1, x2) < box.minX || Math.min(x1, x2) > box.maxX || Math.max(y1, y2) < box.minY || Math.min(y1, y2) > box.maxY) continue;
    line(wall, w, h, gx(x1), gy(y1), gx(x2), gy(y2));
  }

  // Close the gaps: outside = what the border reaches without passing within r cells of a wall,
  // then grown back by r so the outline hugs the walls again.
  const near = within(wall, w, h, r);
  const outside = flood(near, w, h);
  const inside = within(outside, w, h, r);
  for (let i = 0; i < inside.length; i++) inside[i] = inside[i] ? 0 : 1;

  const results: TracedOutline[] = [];
  const label = new Int32Array(w * h);
  let next = 0;
  for (let i = 0; i < inside.length; i++) {
    if (!inside[i] || label[i]) continue;
    const cells = component(inside, label, w, h, i, ++next);
    const areaM2 = cells.length * res * res;
    if (areaM2 < MIN_AREA) continue;
    const ring = outerRing(label, w, h, next, cells);
    if (ring.length < 8) continue;
    const flat: number[] = [];
    for (let k = 0; k < ring.length; k += 2) {
      flat.push(box.minX + (ring[k] - pad) * unit, box.maxY - (ring[k + 1] - pad) * unit);
    }
    results.push({ ring: flat, box: boxOf(flat), area: areaM2 });
  }
  return results;
}

function line(grid: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 100_000; guard++) {
    if (x0 >= 0 && y0 >= 0 && x0 < w && y0 < h) grid[y0 * w + x0] = 1;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** Cells within `r` (chessboard distance) of a set cell: a two-pass distance transform. */
function within(grid: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const INF = 1 << 29;
  const d = new Int32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = grid[i] ? 0 : INF;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 1);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 1);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 1);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 1);
      }
      d[i] = v;
    }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < d.length; i++) out[i] = d[i] <= r ? 1 : 0;
  return out;
}

/** Cells reachable from the grid border through cells that are not blocked. */
function flood(blocked: Uint8Array, w: number, h: number): Uint8Array {
  const reached = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const push = (i: number) => {
    if (!blocked[i] && !reached[i]) {
      reached[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  return reached;
}

function component(mask: Uint8Array, label: Int32Array, w: number, h: number, start: number, id: number): number[] {
  const cells: number[] = [];
  const stack = [start];
  label[start] = id;
  while (stack.length) {
    const i = stack.pop()!;
    cells.push(i);
    const x = i % w;
    const neighbours = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1];
    for (const n of neighbours) {
      if (n >= 0 && mask[n] && !label[n]) {
        label[n] = id;
        stack.push(n);
      }
    }
  }
  return cells;
}

/**
 * The outer boundary of one component as grid-corner vertices [x0, y0, ...]: the cell edges
 * between the component and the rest, chained into loops; the longest loop is the outside.
 */
function outerRing(label: Int32Array, w: number, h: number, id: number, cells: number[]): number[] {
  const inC = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && label[y * w + x] === id;
  // Directed edges, clockwise around each cell in screen coordinates (y down).
  const edges = new Map<number, number[]>();
  const vid = (x: number, y: number) => y * (w + 1) + x;
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const a = vid(ax, ay);
    const list = edges.get(a);
    if (list) list.push(vid(bx, by));
    else edges.set(a, [vid(bx, by)]);
  };
  for (const i of cells) {
    const x = i % w;
    const y = (i - x) / w;
    if (!inC(x, y - 1)) add(x, y, x + 1, y);
    if (!inC(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!inC(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!inC(x - 1, y)) add(x, y + 1, x, y);
  }
  let best: number[] = [];
  for (const startVertex of [...edges.keys()]) {
    let list = edges.get(startVertex);
    if (!list?.length) continue;
    const loop: number[] = [];
    let v = startVertex;
    for (let guard = 0; guard < 4_000_000; guard++) {
      list = edges.get(v);
      if (!list?.length) break;
      const nextVertex = list.pop()!;
      const x = v % (w + 1);
      loop.push(x, (v - x) / (w + 1));
      v = nextVertex;
      if (v === startVertex) break;
    }
    if (loop.length > best.length) best = loop;
  }
  // Drop the collinear corners of the staircase: keep direction changes only.
  const out: number[] = [];
  const n = best.length / 2;
  for (let k = 0; k < n; k++) {
    const p = (k + n - 1) % n;
    const q = (k + 1) % n;
    const turn =
      (best[2 * k] - best[2 * p]) * (best[2 * q + 1] - best[2 * k + 1]) -
      (best[2 * k + 1] - best[2 * p + 1]) * (best[2 * q] - best[2 * k]);
    if (turn !== 0) out.push(best[2 * k], best[2 * k + 1]);
  }
  return out;
}

/**
 * Areas a plan paints with a colour: hatch strokes (dense parallel lines) rasterised, the gaps
 * between them closed (`closeMetres`), and each covered area's outer ring traced. Thin lines
 * (stall partitions of the same colour) stay thin and are dropped by `minThickness`.
 * Rings are in drawing units (y up), not simplified.
 */
export function coveredRegions(
  segments: number[],
  box: Box,
  metresPerUnit: number,
  opts: { closeMetres: number; minArea: number; minThickness: number },
): TracedOutline[] {
  const s = metresPerUnit;
  const widthM = (box.maxX - box.minX) * s;
  const heightM = (box.maxY - box.minY) * s;
  if (!segments.length || widthM <= 0 || heightM <= 0) return [];
  const res = Math.max(0.12, Math.sqrt((widthM * heightM) / MAX_CELLS));
  const r = Math.max(1, Math.round(opts.closeMetres / res));
  const pad = r + 2;
  const w = Math.ceil(widthM / res) + 2 * pad;
  const h = Math.ceil(heightM / res) + 2 * pad;
  const unit = res / s;
  const gx = (x: number) => Math.floor((x - box.minX) / unit) + pad;
  const gy = (y: number) => Math.floor((box.maxY - y) / unit) + pad;

  const ink = new Uint8Array(w * h);
  for (let i = 0; i < segments.length; i += 4) {
    const [x1, y1, x2, y2] = [segments[i], segments[i + 1], segments[i + 2], segments[i + 3]];
    if (Math.max(x1, x2) < box.minX || Math.min(x1, x2) > box.maxX || Math.max(y1, y2) < box.minY || Math.min(y1, y2) > box.maxY) continue;
    line(ink, w, h, gx(x1), gy(y1), gx(x2), gy(y2));
  }
  // Closing: grow by r, then shrink back by r, so hatch gaps fill and edges stay put.
  const grown = within(ink, w, h, r);
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < outside.length; i++) outside[i] = grown[i] ? 0 : 1;
  const nearOutside = within(outside, w, h, r);
  const covered = new Uint8Array(w * h);
  for (let i = 0; i < covered.length; i++) covered[i] = grown[i] && !nearOutside[i] ? 1 : 0;

  // Zones cannot have holes. A ring-shaped area (a peripheral band around the stall floor) is cut
  // through the middle of each hole, so it becomes pieces without holes and never swallows the
  // floor it surrounds.
  const background = new Uint8Array(w * h);
  for (let i = 0; i < background.length; i++) background[i] = covered[i] ? 0 : 1;
  const open = flood(covered, w, h);
  const holeLabel = new Int32Array(w * h);
  let holes = 0;
  for (let i = 0; i < background.length; i++) {
    if (!background[i] || open[i] || holeLabel[i]) continue;
    const cells = component(background, holeLabel, w, h, i, ++holes);
    if (cells.length * res * res < 1) continue;
    const col = Math.round(cells.reduce((sum, c) => sum + (c % w), 0) / cells.length);
    for (let y = 0; y < h; y++) covered[y * w + col] = 0;
  }

  const results: TracedOutline[] = [];
  const label = new Int32Array(w * h);
  let next = 0;
  for (let i = 0; i < covered.length; i++) {
    if (!covered[i] || label[i]) continue;
    const cells = component(covered, label, w, h, i, ++next);
    const area = cells.length * res * res;
    if (area < opts.minArea) continue;
    let edges = 0;
    for (const c of cells) {
      const x = c % w;
      if (x === 0 || label[c - 1] !== next) edges++;
      if (x === w - 1 || label[c + 1] !== next) edges++;
      if (c < w || label[c - w] !== next) edges++;
      if (c >= w * (h - 1) || label[c + w] !== next) edges++;
    }
    // Mean thickness of a strip: 2 * area / perimeter.
    if ((2 * area) / (edges * res) < opts.minThickness) continue;
    const ring = outerRing(label, w, h, next, cells);
    if (ring.length < 8) continue;
    const flat: number[] = [];
    for (let k = 0; k < ring.length; k += 2) flat.push(box.minX + (ring[k] - pad) * unit, box.maxY - (ring[k + 1] - pad) * unit);
    results.push({ ring: flat, box: boxOf(flat), area });
  }
  return results.sort((a, b) => b.area - a.area);
}

/**
 * Areas a colour encloses: the gaps inside painted rings, e.g. each hall's stall floor inside
 * its red peripheral passage. Same raster as `coveredRegions`; returns the outer ring of every
 * enclosed area of at least `minArea` m², largest first. Rings in drawing units (y up).
 */
export function enclosedAreas(
  segments: number[],
  box: Box,
  metresPerUnit: number,
  /** `withBandMetres`: also take the painted band around each area, up to this wide. */
  opts: { closeMetres: number; minArea: number; withBandMetres?: number },
): TracedOutline[] {
  const s = metresPerUnit;
  const widthM = (box.maxX - box.minX) * s;
  const heightM = (box.maxY - box.minY) * s;
  if (!segments.length || widthM <= 0 || heightM <= 0) return [];
  const res = Math.max(0.2, Math.sqrt((widthM * heightM) / MAX_CELLS));
  const r = Math.max(1, Math.round(opts.closeMetres / res));
  const pad = r + 2;
  const w = Math.ceil(widthM / res) + 2 * pad;
  const h = Math.ceil(heightM / res) + 2 * pad;
  const unit = res / s;
  const gx = (x: number) => Math.floor((x - box.minX) / unit) + pad;
  const gy = (y: number) => Math.floor((box.maxY - y) / unit) + pad;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < segments.length; i += 4) {
    const [x1, y1, x2, y2] = [segments[i], segments[i + 1], segments[i + 2], segments[i + 3]];
    if (Math.max(x1, x2) < box.minX || Math.min(x1, x2) > box.maxX || Math.max(y1, y2) < box.minY || Math.min(y1, y2) > box.maxY) continue;
    line(ink, w, h, gx(x1), gy(y1), gx(x2), gy(y2));
  }
  const painted = within(ink, w, h, r);
  const open = flood(painted, w, h);
  const free = new Uint8Array(w * h);
  for (let i = 0; i < free.length; i++) free[i] = !painted[i] && !open[i] ? 1 : 0;
  const label = new Int32Array(w * h);
  const results: TracedOutline[] = [];
  let next = 0;
  for (let i = 0; i < free.length; i++) {
    if (!free[i] || label[i]) continue;
    let cells = component(free, label, w, h, i, ++next);
    const area = cells.length * res * res;
    if (area < opts.minArea) continue;
    if (opts.withBandMetres) {
      // Grow into the paint around the area (its passage band), at most the band's width.
      const limit = Math.round(opts.withBandMetres / res);
      const dist = new Int32Array(w * h).fill(-1);
      const queue = new Int32Array(w * h);
      let head = 0;
      let tail = 0;
      for (const c of cells) {
        dist[c] = 0;
        queue[tail++] = c;
      }
      while (head < tail) {
        const c = queue[head++];
        if (dist[c] >= limit) continue;
        const x = c % w;
        for (const n of [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, c >= w ? c - w : -1, c < w * (h - 1) ? c + w : -1]) {
          if (n >= 0 && painted[n] && dist[n] < 0) {
            dist[n] = dist[c] + 1;
            label[n] = next;
            queue[tail++] = n;
          }
        }
      }
      cells = Array.from(queue.subarray(0, tail));
    }
    const ring = outerRing(label, w, h, next, cells);
    if (ring.length < 8) continue;
    const flat: number[] = [];
    for (let k = 0; k < ring.length; k += 2) flat.push(box.minX + (ring[k] - pad) * unit, box.maxY - (ring[k + 1] - pad) * unit);
    results.push({ ring: flat, box: boxOf(flat), area });
  }
  return results.sort((a, b) => b.area - a.area);
}

/**
 * Splits a building outline between the halls it holds. Every part of the building goes to the
 * hall floor it is nearest to walking inside the building (a geodesic nearest-seed fill), so each
 * hall takes its own service cores and foyer, and neighbouring halls meet halfway across the
 * wall or passage between them. Returns one ring per seed (same order), or null for a seed that
 * got no area. Rings in drawing units (y up).
 */
export function splitBySeeds(building: number[], seeds: number[][], metresPerUnit: number): Array<number[] | null> {
  const s = metresPerUnit;
  const b = boxOf(building);
  const widthM = (b.maxX - b.minX) * s;
  const heightM = (b.maxY - b.minY) * s;
  const res = Math.max(0.2, Math.sqrt((widthM * heightM) / MAX_CELLS));
  const pad = 2;
  const w = Math.ceil(widthM / res) + 2 * pad;
  const h = Math.ceil(heightM / res) + 2 * pad;
  const unit = res / s;
  const inside = fillPolygon(building, b, unit, pad, w, h);
  const owner = new Int32Array(w * h); // 0 = none, k + 1 = seed k
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  seeds.forEach((seed, k) => {
    const cells = fillPolygon(seed, b, unit, pad, w, h);
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] && inside[i] && !owner[i]) {
        owner[i] = k + 1;
        queue[tail++] = i;
      }
    }
  });
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const neighbours = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1];
    for (const n of neighbours) {
      if (n >= 0 && inside[n] && !owner[n]) {
        owner[n] = owner[i];
        queue[tail++] = n;
      }
    }
  }
  return seeds.map((_, k) => {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < owner.length; i++) mask[i] = owner[i] === k + 1 ? 1 : 0;
    // The largest connected piece is the hall; stray slivers are dropped.
    const label = new Int32Array(w * h);
    let best: { id: number; cells: number[] } | null = null;
    let next = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || label[i]) continue;
      const cells = component(mask, label, w, h, i, ++next);
      if (!best || cells.length > best.cells.length) best = { id: next, cells };
    }
    if (!best) return null;
    const ring = outerRing(label, w, h, best.id, best.cells);
    if (ring.length < 8) return null;
    const flat: number[] = [];
    for (let k2 = 0; k2 < ring.length; k2 += 2) flat.push(b.minX + (ring[k2] - pad) * unit, b.maxY - (ring[k2 + 1] - pad) * unit);
    return flat;
  });
}

/** Scanline fill of a polygon (drawing units) into a grid laid over `box`. */
function fillPolygon(ring: number[], box: Box, unit: number, pad: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const n = ring.length / 2;
  for (let row = 0; row < h; row++) {
    const y = box.maxY - (row - pad + 0.5) * unit;
    const xs: number[] = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi, xj, yj] = [ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1]];
      if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
    }
    xs.sort((a, c) => a - c);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil((xs[k] - box.minX) / unit - 0.5) + pad);
      const to = Math.min(w - 1, Math.floor((xs[k + 1] - box.minX) / unit - 0.5) + pad);
      for (let col = from; col <= to; col++) out[row * w + col] = 1;
    }
  }
  return out;
}

/**
 * Straight strips that cross a box (partitions, smoke curtains), found by projection: a column
 * (or row, `alongX` false) of the rasterised strokes that is painted over at least `minCover`
 * of the box's depth. Robust where strips are joined by cross-lines, which makes connected
 * components useless. Returns strip centres in drawing units, left to right.
 */
export function crossingStrips(
  segments: number[],
  box: Box,
  metresPerUnit: number,
  opts: { alongX: boolean; minCover: number; maxWidthMetres: number },
): number[] {
  const s = metresPerUnit;
  const widthM = (box.maxX - box.minX) * s;
  const heightM = (box.maxY - box.minY) * s;
  if (!segments.length || widthM <= 0 || heightM <= 0) return [];
  const res = Math.max(0.2, Math.sqrt((widthM * heightM) / MAX_CELLS));
  const w = Math.ceil(widthM / res) + 1;
  const h = Math.ceil(heightM / res) + 1;
  const unit = res / s;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < segments.length; i += 4) {
    const [x1, y1, x2, y2] = [segments[i], segments[i + 1], segments[i + 2], segments[i + 3]];
    if (Math.max(x1, x2) < box.minX || Math.min(x1, x2) > box.maxX || Math.max(y1, y2) < box.minY || Math.min(y1, y2) > box.maxY) continue;
    line(ink, w, h, Math.floor((x1 - box.minX) / unit), Math.floor((box.maxY - y1) / unit), Math.floor((x2 - box.minX) / unit), Math.floor((box.maxY - y2) / unit));
  }
  // Hatch has gaps between its strokes: a cell counts when it or a neighbour across is inked.
  const lanes = opts.alongX ? w : h;
  const depth = opts.alongX ? h : w;
  const cover = new Float64Array(lanes);
  for (let lane = 0; lane < lanes; lane++) {
    let n = 0;
    for (let k = 0; k < depth; k++) {
      const at = (dl: number) => {
        const l = lane + dl;
        if (l < 0 || l >= lanes) return 0;
        return opts.alongX ? ink[k * w + l] : ink[l * w + k];
      };
      if (at(0) || at(-1) || at(1)) n++;
    }
    cover[lane] = n / depth;
  }
  const centres: number[] = [];
  const maxLanes = Math.max(1, Math.round(opts.maxWidthMetres / res));
  for (let lane = 0; lane < lanes; ) {
    if (cover[lane] < opts.minCover) {
      lane++;
      continue;
    }
    let end = lane;
    while (end + 1 < lanes && cover[end + 1] >= opts.minCover) end++;
    if (end - lane + 1 <= maxLanes) {
      const mid = (lane + end + 1) / 2;
      centres.push(opts.alongX ? box.minX + mid * unit : box.maxY - mid * unit);
    }
    lane = end + 1;
  }
  return opts.alongX ? centres : centres.reverse();
}
