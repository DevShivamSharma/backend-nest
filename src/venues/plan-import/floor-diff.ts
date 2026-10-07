import { blocksStalls, FloorRect, HallFloor } from '../floor/hall-floor';
import { mergeRects } from './build-hall';

/**
 * Old against new stall floor of a hall. The two floors may be drawn from different origins
 * (an ITPO layout includes its walls, a plan import starts at the grid), so the new floor is
 * shifted over the old one to where they agree best before comparing.
 */
export interface FloorDiff {
  /** Where the new floor's (0, 0) lies on the old one, metres. */
  offset: { x: number; y: number };
  /** Intersection over union of the two stall floors. */
  iou: number;
  oldArea: number;
  newArea: number;
  /** Stall floor in the new floor only, and in the old only, m². */
  added: number;
  removed: number;
  /** In the old floor's coordinates. */
  addedRects: FloorRect[];
  removedRects: FloorRect[];
}

const RES = 0.25;
const SEARCH = 8;

export function floorDiff(oldFloor: HallFloor, newFloor: HallFloor): FloorDiff {
  // Coarse search on a 1 m raster, then refine on the fine one.
  const coarseOld = stallMask(oldFloor, 1);
  const coarseNew = stallMask(newFloor, 1);
  let best = { dx: 0, dy: 0, score: -1 };
  for (let dy = -SEARCH; dy <= SEARCH; dy++) {
    for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      const score = overlap(coarseOld, coarseNew, dx, dy);
      if (score > best.score) best = { dx, dy, score };
    }
  }
  const fineOld = stallMask(oldFloor, RES);
  const fineNew = stallMask(newFloor, RES);
  const steps = Math.round(1 / RES);
  let fine = { dx: best.dx * steps, dy: best.dy * steps, score: -1 };
  for (let dy = best.dy * steps - steps; dy <= best.dy * steps + steps; dy++) {
    for (let dx = best.dx * steps - steps; dx <= best.dx * steps + steps; dx++) {
      const score = overlap(fineOld, fineNew, dx, dy);
      if (score > fine.score) fine = { dx, dy, score };
    }
  }

  const { w, h } = fineOld;
  const inNew = (x: number, y: number) => {
    const nx = x - fine.dx;
    const ny = y - fine.dy;
    return (
      nx >= 0 && ny >= 0 && nx < fineNew.w && ny < fineNew.h && fineNew.m[ny * fineNew.w + nx] === 1
    );
  };
  // Cover both floors: extend the old raster's frame to wherever the shifted new one reaches.
  const minX = Math.min(0, fine.dx);
  const minY = Math.min(0, fine.dy);
  const maxX = Math.max(w, fine.dx + fineNew.w);
  const maxY = Math.max(h, fine.dy + fineNew.h);
  const W = maxX - minX;
  const H = maxY - minY;
  const added = new Uint8Array(W * H);
  const removed = new Uint8Array(W * H);
  let inter = 0;
  let a = 0;
  let b = 0;
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const o = x >= 0 && y >= 0 && x < w && y < h && fineOld.m[y * w + x] === 1;
      const n = inNew(x, y);
      const k = (y - minY) * W + (x - minX);
      if (o) a++;
      if (n) b++;
      if (o && n) inter++;
      if (n && !o) added[k] = 1;
      if (o && !n) removed[k] = 1;
    }
  }
  const cell = RES * RES;
  const shift = (r: FloorRect): FloorRect => ({
    ...r,
    x: Math.round((r.x + minX * RES) * 1000) / 1000,
    y: Math.round((r.y + minY * RES) * 1000) / 1000,
  });
  return {
    offset: { x: fine.dx * RES, y: fine.dy * RES },
    iou: a + b - inter ? Math.round((inter / (a + b - inter)) * 10000) / 10000 : 1,
    oldArea: Math.round(a * cell),
    newArea: Math.round(b * cell),
    added: Math.round((b - inter) * cell),
    removed: Math.round((a - inter) * cell),
    addedRects: mergeRects(W, H, (k) => added[k] === 1, RES).map(shift),
    removedRects: mergeRects(W, H, (k) => removed[k] === 1, RES).map(shift),
  };
}

/** 1 where stalls may stand: on the floor's extent and under no blocking area. */
export function stallMask(floor: HallFloor, res: number): { w: number; h: number; m: Uint8Array } {
  const w = Math.max(1, Math.ceil(floor.width / res));
  const h = Math.max(1, Math.ceil(floor.depth / res));
  const m = new Uint8Array(w * h).fill(1);
  for (const area of floor.areas) {
    if (area.kind !== 'outside' && !blocksStalls(area.kind)) continue;
    const c0 = Math.max(0, Math.ceil(area.x / res - 0.5));
    const c1 = Math.min(w - 1, Math.floor((area.x + area.width) / res - 0.5 - 1e-9));
    const r0 = Math.max(0, Math.ceil(area.y / res - 0.5));
    const r1 = Math.min(h - 1, Math.floor((area.y + area.height) / res - 0.5 - 1e-9));
    for (let r = r0; r <= r1; r++) if (c0 <= c1) m.fill(0, r * w + c0, r * w + c1 + 1);
  }
  return { w, h, m };
}

function overlap(
  a: { w: number; h: number; m: Uint8Array },
  b: { w: number; h: number; m: Uint8Array },
  dx: number,
  dy: number,
): number {
  let inter = 0;
  for (let y = Math.max(0, dy); y < Math.min(a.h, b.h + dy); y++) {
    for (let x = Math.max(0, dx); x < Math.min(a.w, b.w + dx); x++) {
      if (a.m[y * a.w + x] && b.m[(y - dy) * b.w + (x - dx)]) inter++;
    }
  }
  return inter;
}
