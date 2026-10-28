/**
 * ITPO lays a hall out on a grid of 1 m cells, `length` cells along x and `breadth` along y, and
 * marks the cells that cannot be used (walls, cut corners) as rectangles in `nonClickableAreas`.
 * A hall drawn by size has a width and depth in metres (fractions allowed) and, for a custom
 * shape, an outline of corners; this turns that into the grid ITPO stores.
 *
 * A cell is usable when its centre is inside the outline. Works row by row, so a 2000 m side
 * costs 2000 rows, not millions of cells.
 */

/** A corner of an outline, [x, y] in metres, origin top-left, y down. */
export type Corner = [number, number];

export interface BlockedArea {
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor: string;
  strokeColor: string;
}

/** The colour ITPO's own layouts give the walls and blocked cells. */
const BLOCKED_COLOR = '#ffffff';

/** The grid ITPO stores for a hall: whole cells, enough to hold its width and depth. */
export function gridSize(width: number, depth: number): { columns: number; rows: number } {
  return { columns: Math.ceil(width), rows: Math.ceil(depth) };
}

/** Why the outline cannot be a hall, or null when it can. */
export function outlineError(outline: Corner[], width: number, depth: number): string | null {
  if (outline.some(([x, y]) => x < 0 || x > width || y < 0 || y > depth)) {
    return 'The outline must stay inside the hall (0 to width across, 0 to depth down).';
  }
  if (crossesItself(outline)) {
    return 'The outline must not cross itself.';
  }

  const { columns, rows } = gridSize(width, depth);
  let usable = 0;
  for (let y = 0; y < rows; y++) {
    for (const [first, last] of usableRuns(outline, y, columns)) {
      usable += last - first + 1;
    }
  }
  return usable === 0 ? 'The outline leaves no usable floor.' : null;
}

/** The blocked rectangles for a hall drawn by size; none for a whole-metre rectangle. */
export function blockedAreas(width: number, depth: number, outline?: Corner[]): BlockedArea[] {
  const ring = outline ?? rectangle(width, depth);
  const { columns, rows } = gridSize(width, depth);

  // Row by row, the runs of cells that are not usable.
  const blockedRows: { x: number; width: number }[][] = [];
  for (let y = 0; y < rows; y++) {
    const runs: { x: number; width: number }[] = [];
    let next = 0;
    for (const [first, last] of usableRuns(ring, y, columns)) {
      if (first > next) {
        runs.push({ x: next, width: first - next });
      }
      next = last + 1;
    }
    if (next < columns) {
      runs.push({ x: next, width: columns - next });
    }
    blockedRows.push(runs);
  }

  // The same run in rows directly below one another becomes one taller rectangle.
  const areas: BlockedArea[] = [];
  const open = new Map<string, BlockedArea>();
  for (let y = 0; y <= rows; y++) {
    const runs = y < rows ? blockedRows[y] : [];
    const keys = new Set(runs.map((r) => `${r.x}:${r.width}`));
    for (const [key, area] of open) {
      if (!keys.has(key)) {
        areas.push(area);
        open.delete(key);
      }
    }
    for (const run of runs) {
      const key = `${run.x}:${run.width}`;
      const existing = open.get(key);
      if (existing) {
        existing.height += 1;
      } else {
        open.set(key, {
          x: run.x,
          y,
          width: run.width,
          height: 1,
          fillColor: BLOCKED_COLOR,
          strokeColor: BLOCKED_COLOR,
        });
      }
    }
  }

  return areas;
}

function rectangle(width: number, depth: number): Corner[] {
  return [
    [0, 0],
    [width, 0],
    [width, depth],
    [0, depth],
  ];
}

/**
 * The runs of usable cells (first and last column, inclusive) in one row: those whose centre is
 * inside the outline, by the even-odd rule along the row's centre line.
 */
function usableRuns(ring: Corner[], row: number, columns: number): [number, number][] {
  const yc = row + 0.5;
  const crossings: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[j];
    if (ay > yc !== by > yc) {
      crossings.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
    }
  }
  crossings.sort((a, b) => a - b);

  const runs: [number, number][] = [];
  for (let k = 0; k + 1 < crossings.length; k += 2) {
    // Columns whose centre c = i + 0.5 satisfies crossings[k] <= c < crossings[k + 1].
    const first = Math.max(0, Math.ceil(crossings[k] - 0.5));
    const last = Math.min(columns - 1, Math.ceil(crossings[k + 1] - 0.5) - 1);
    if (last >= first) {
      runs.push([first, last]);
    }
  }
  return runs;
}

function crossesItself(ring: Corner[]): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) {
        continue;
      }
      if (segmentsIntersect(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) {
        return true;
      }
    }
  }
  return false;
}

function segmentsIntersect(a: Corner, b: Corner, c: Corner, d: Corner): boolean {
  const cross = (o: Corner, p: Corner, q: Corner) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const onSegment = (p: Corner, q: Corner, r: Corner) =>
    Math.min(p[0], q[0]) <= r[0] &&
    r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] &&
    r[1] <= Math.max(p[1], q[1]);

  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return (
    (d1 === 0 && onSegment(c, d, a)) ||
    (d2 === 0 && onSegment(c, d, b)) ||
    (d3 === 0 && onSegment(a, b, c)) ||
    (d4 === 0 && onSegment(a, b, d))
  );
}
