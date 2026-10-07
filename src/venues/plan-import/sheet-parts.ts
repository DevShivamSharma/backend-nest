import {
  decodeMapCells,
  decodeRegions,
  SheetAnalysis,
} from '../../integrations/drawings/drawing-analysis';
import { OUTSIDE } from '../../integrations/drawings/grid-map';

/**
 * The separate pieces of floor on one sheet ("parts"), as connected cells of its map. A hall
 * is one or more parts; a foyer is a part of its own when the plan draws it apart. The person
 * importing can cut a part with a rectangle, which makes the cut cells a new part.
 */

/** A rectangle the person drew to cut cells out of their part, in map units of the sheet. */
export interface PartCut {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SheetPart {
  /** Stable within the sheet for the same analysis and cuts. */
  id: number;
  /** Map cells. */
  cells: number;
  /** Box in map cells (inclusive). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Made by a cut. */
  cut: boolean;
  /** The grid it is drawn on (most of its cells); see `PlanMap.regionOf`. */
  region: number;
}

export interface SheetParts {
  cols: number;
  rows: number;
  sub: number;
  /** The map's cells. */
  cells: Int16Array;
  /** Part id of each map cell, -1 outside. */
  partOf: Int32Array;
  parts: SheetPart[];
  /** Pairs of parts and the gap between them in map units (only gaps up to the search radius). */
  gaps: Map<string, number>;
}

export const gapKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Gaps wider than this many map units are not searched: the parts are not neighbours. */
const GAP_RADIUS_UNITS = 25;

export function sheetParts(sheet: SheetAnalysis, cuts: PartCut[]): SheetParts {
  const { cols, rows, sub } = sheet.map;
  const cells = decodeMapCells(sheet.map);
  const regionOf = decodeRegions(sheet.map);
  const partOf = new Int32Array(cols * rows).fill(-1);

  // Cells inside a cut are their own region: labelled after the uncut ones.
  const cutOf = new Int16Array(cols * rows).fill(-1);
  cuts.forEach((cut, index) => {
    const cx0 = Math.max(0, Math.floor(cut.x * sub));
    const cy0 = Math.max(0, Math.floor(cut.y * sub));
    const cx1 = Math.min(cols, Math.ceil((cut.x + cut.width) * sub));
    const cy1 = Math.min(rows, Math.ceil((cut.y + cut.height) * sub));
    for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) cutOf[y * cols + x] = index;
  });

  const parts: SheetPart[] = [];
  const stack: number[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (cells[start] === OUTSIDE || partOf[start] !== -1) continue;
    const id = parts.length;
    const region = cutOf[start];
    const part: SheetPart = {
      id,
      cells: 0,
      x0: cols,
      y0: rows,
      x1: -1,
      y1: -1,
      cut: region >= 0,
      region: 0,
    };
    const regionVotes = new Map<number, number>();
    partOf[start] = id;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      part.cells++;
      regionVotes.set(regionOf[k], (regionVotes.get(regionOf[k]) ?? 0) + 1);
      const x = k % cols;
      const y = (k - x) / cols;
      if (x < part.x0) part.x0 = x;
      if (x > part.x1) part.x1 = x;
      if (y < part.y0) part.y0 = y;
      if (y > part.y1) part.y1 = y;
      for (const n of [x > 0 ? k - 1 : -1, x < cols - 1 ? k + 1 : -1, k - cols, k + cols]) {
        if (n < 0 || n >= cells.length || cells[n] === OUTSIDE || partOf[n] !== -1) continue;
        if (cutOf[n] !== region) continue;
        partOf[n] = id;
        stack.push(n);
      }
    }
    part.region = [...regionVotes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    parts.push(part);
  }

  return { cols, rows, sub, cells, partOf, parts, gaps: partGaps(partOf, cols, sub) };
}

/**
 * The gap between neighbouring parts: a breadth-first wave from every part at once; where two
 * parts' waves meet, the gap is the sum of their distances.
 */
function partGaps(partOf: Int32Array, cols: number, sub: number): Map<string, number> {
  const radius = GAP_RADIUS_UNITS * sub;
  const owner = Int32Array.from(partOf);
  const dist = new Int32Array(partOf.length).fill(-1);
  let frontier: number[] = [];
  for (let k = 0; k < partOf.length; k++) {
    if (partOf[k] >= 0) {
      dist[k] = 0;
      frontier.push(k);
    }
  }
  const gaps = new Map<string, number>();
  const meet = (a: number, b: number, gapCells: number) => {
    if (a === b) return;
    const key = gapKey(a, b);
    const gap = gapCells / sub;
    if (!gaps.has(key) || gaps.get(key)! > gap) gaps.set(key, gap);
  };
  for (let d = 0; d <= radius && frontier.length; d++) {
    const next: number[] = [];
    for (const k of frontier) {
      const x = k % cols;
      for (const n of [x > 0 ? k - 1 : -1, x < cols - 1 ? k + 1 : -1, k - cols, k + cols]) {
        if (n < 0 || n >= partOf.length) continue;
        if (dist[n] === -1) {
          dist[n] = d + 1;
          owner[n] = owner[k];
          next.push(n);
        } else if (owner[n] !== owner[k]) {
          // The cells between the two parts: each wave's distance from its own part.
          meet(owner[n], owner[k], dist[n] + dist[k]);
        }
      }
    }
    frontier = next;
  }
  return gaps;
}

/** Map cells of one part, or of several. */
export function cellsOf(parts: SheetParts, ids: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (let k = 0; k < parts.partOf.length; k++) if (ids.has(parts.partOf[k])) out.push(k);
  return out;
}
