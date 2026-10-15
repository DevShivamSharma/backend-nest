/**
 * A stall is a rectangle with some of its 1 m grid cells cut away, the way SelfCare draws one:
 * its `cutCells` are [column, row] of the cells taken out, counted from the stall's top-left
 * corner. A stall off whole metres has part cells on its far edges; cutting one takes only the
 * part inside the stall.
 */
export interface CellStall {
  width: number;
  depth: number;
  cutCells: ReadonlyArray<readonly [number, number]>;
}

const EPS = 1e-6;

/** Columns and rows of cells the stall touches. */
export function cellCounts(s: Pick<CellStall, 'width' | 'depth'>): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.ceil(s.width - EPS)),
    rows: Math.max(1, Math.ceil(s.depth - EPS)),
  };
}

/**
 * The cut cells as kept: whole numbers inside the stall, each once, sorted; never every cell,
 * as a stall needs at least one.
 */
export function cleanCutCells(
  s: Pick<CellStall, 'width' | 'depth'>,
  cells: ReadonlyArray<readonly number[]>,
): Array<[number, number]> {
  const { cols, rows } = cellCounts(s);
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const [c, r] of cells) {
    if (!Number.isInteger(c) || !Number.isInteger(r)) continue;
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    const key = `${c},${r}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([c, r]);
  }
  if (out.length >= cols * rows) return [];
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/** The stall's floor area, m²: its rectangle less the cells cut away. */
export function stallArea(s: CellStall): number {
  let area = s.width * s.depth;
  for (const [c, r] of s.cutCells) {
    area -= Math.max(0, Math.min(1, s.width - c)) * Math.max(0, Math.min(1, s.depth - r));
  }
  return Math.max(0, area);
}

/** Whether a cell is cut away. */
export function isCut(s: Pick<CellStall, 'cutCells'>, c: number, r: number): boolean {
  return s.cutCells.some(([cc, rr]) => cc === c && rr === r);
}
