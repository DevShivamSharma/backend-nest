import type { FloorArea, FloorAreaKind } from '../../venues/floor/hall-floor';
import type { RgbImage } from './raster';

/**
 * Finds the stall grid of a hall plan and turns it into a map of the floor, in grid cells.
 *
 * The rule that keeps the result true to the plan: only cells of the drawn grid are floor. A
 * cell is a grid cell when the plan draws at least three of its four sides as thin lines on
 * the grid's lattice. Coloured bands drawn over the grid (passages, fire curtains, columns, a
 * hall's edge strip) hide its lines; such a band becomes floor too when it lies against the
 * grid, as a typed area. Everything else (rooms, the legend, the title block, the street) is
 * outside the hall.
 *
 * The map is in grid cells, not metres: how many metres a cell is comes from the plan's own
 * evidence (a stated grid size, dimension lines, the file's units) or from the person importing,
 * never from an assumption here. Bands keep their drawn width at sub-cell resolution, so a 1 m
 * band that straddles two cells stays 1 m wide.
 */

/** What the map says about one map cell. Values >= 0 are overlay groups (`PlanMap.groups`). */
export const OUTSIDE = -2;
export const FLOOR = -1;

/** A colour drawn over the floor, with the kind of area its colour suggests. */
export interface OverlayGroup {
  id: number;
  /** Representative colour, `#rrggbb`. */
  color: string;
  /** Broad colour family. */
  family: ColorFamily;
  /**
   * The kind the colour alone suggests: a last resort, used only when the plan's legend does
   * not name the colour. Shown as a guess for the person to confirm.
   */
  kind: FloorAreaKind;
  /** Number of map cells. */
  cells: number;
}

/**
 * The floor found on one sheet. `unit` is one grid cell (or, without a grid, a fixed number
 * of pixels); a map cell is `1 / sub` of a unit on each side.
 */
export interface PlanMap {
  /** How the floor was found: from the drawn grid, or from the walls (no grid). */
  source: 'grid' | 'outline';
  /** Map cells per unit, per side. */
  sub: number;
  cols: number;
  rows: number;
  /** Row-major: `OUTSIDE`, `FLOOR` or an overlay group id. */
  cells: Int16Array;
  groups: OverlayGroup[];
  /** Plan pixels per unit, per axis (for a grid: its pitch). */
  unitPxX: number;
  unitPxY: number;
  /** The plan pixel at map (0, 0). */
  originX: number;
  originY: number;
  /** Lattice cells found as drawn grid (0 without a grid). */
  gridCells: number;
  /** Separate grids found (a hall and its foyer drawn on shifted grids count two). */
  regions: number;
  /**
   * Which grid each map cell's floor is drawn on (index into the regions, 255 off the floor).
   * Floor on one grid is one floor; a piece on a shifted grid was drawn as a separate space.
   */
  regionOf: Uint8Array;
  warnings: string[];
}

export class NoGridError extends Error {}

/** Fewest grid cells a part of the hall must have; smaller finds are drawing noise. */
const MIN_REGION_CELLS = 40;
/** Share of a side's length that must be drawn for the side to count. */
const SIDE_COVERAGE = 0.6;
/** Smallest believable grid pitch in pixels; a finer grid cannot be read reliably. */
const MIN_PITCH = 4;
/** Finest map: this many map cells per grid cell (and never finer than a pixel). */
const MAX_SUB = 10;

export function analyseGrid(img: RgbImage): PlanMap {
  const warnings: string[] = [];
  const { vertical, horizontal } = lineMasks(img);

  const profileX = profile(vertical, img.width, img.height, 'x');
  const profileY = profile(horizontal, img.width, img.height, 'y');
  let pitchX = findPitch(profileX);
  let pitchY = findPitch(profileY);
  if (!pitchX || !pitchY) {
    throw new NoGridError('No stall grid was found on this plan.');
  }
  // Lines every half cell on one axis (stall rows drawn between grid lines) can make that
  // axis read half the pitch. When one pitch is about twice the other and the doubled one is
  // also strong, the grid is the coarser one.
  const strongAt = (prof: Float64Array, p: number) => fourier(prof, p).strength;
  if (
    Math.abs(pitchX / pitchY - 2) < 0.06 &&
    strongAt(profileY, pitchY * 2) >= 0.5 * strongAt(profileY, pitchY)
  ) {
    pitchY = refinePitch(profileY, pitchY * 2);
  } else if (
    Math.abs(pitchY / pitchX - 2) < 0.06 &&
    strongAt(profileX, pitchX * 2) >= 0.5 * strongAt(profileX, pitchX)
  ) {
    pitchX = refinePitch(profileX, pitchX * 2);
  }
  if (Math.abs(pitchX - pitchY) > 0.03 * Math.max(pitchX, pitchY)) {
    warnings.push(
      `The grid's cells are not square in this file (${pitchX.toFixed(2)} × ${pitchY.toFixed(2)} px): ` +
        'the plan may be stretched. Each axis follows its own grid.',
    );
  }

  // Find each part of the hall: the strongest lattice first, then what is left.
  const regions: Region[] = [];
  for (let pass = 0; pass < 8; pass++) {
    const found = findRegion(img, vertical, horizontal, pitchX, pitchY);
    if (!found) break;
    regions.push(found);
    clearRegion(found, vertical, horizontal, img.width, img.height);
  }
  if (!regions.length) {
    throw new NoGridError(
      'The plan has a regular pattern but no area of grid cells large enough to be a hall.',
    );
  }
  regions.sort((a, b) => b.gridCells - a.gridCells);

  const colors = cellColors(img, regions);
  const families: Array<Map<number, ColorFamily>> = [];
  for (const [r, region] of regions.entries()) {
    families.push(acceptOverlays(region, colors[r]));
  }

  return toCellMap(img, regions, families, pitchX, pitchY, warnings);
}

/** The square-grid evidence: pitch on each axis in pixels. */
export function gridPitch(map: PlanMap): { x: number; y: number } | null {
  return map.source === 'grid' ? { x: map.unitPxX, y: map.unitPxY } : null;
}

/** The grid's pitch in pixels, or null when the image shows no grid. */
export function estimatePitch(img: RgbImage): number | null {
  const { vertical, horizontal } = lineMasks(img);
  const x = findPitch(profile(vertical, img.width, img.height, 'x'));
  const y = findPitch(profile(horizontal, img.width, img.height, 'y'));
  return x && y ? (x + y) / 2 : (x ?? y);
}

// ---- line masks ---------------------------------------------------------------------------

/**
 * Pixels that are part of a thin line: darker than the pixels two steps away on both sides.
 * Vertical lines are found across x, horizontal ones across y. Wide dark shapes are not lines.
 */
function lineMasks(img: RgbImage): { vertical: Uint8Array; horizontal: Uint8Array } {
  const { width: W, height: H, data } = img;
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    lum[i] = 0.299 * data[3 * i] + 0.587 * data[3 * i + 1] + 0.114 * data[3 * i + 2];
  }
  const vertical = new Uint8Array(W * H);
  const horizontal = new Uint8Array(W * H);
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      const c = lum[i];
      if (c > 240) continue;
      const l = lum[i - 2];
      const r = lum[i + 2];
      if (Math.min(l, r) - c > 15 && Math.max(l, r) > 150) vertical[i] = 1;
      const u = lum[i - 2 * W];
      const d = lum[i + 2 * W];
      if (Math.min(u, d) - c > 15 && Math.max(u, d) > 150) horizontal[i] = 1;
    }
  }
  return { vertical, horizontal };
}

function profile(mask: Uint8Array, W: number, H: number, axis: 'x' | 'y'): Float64Array {
  const out = new Float64Array(axis === 'x' ? W : H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) out[axis === 'x' ? x : y]++;
    }
  }
  return out;
}

/** Strength and phase of a periodic signal of period `p` in a profile. */
function fourier(prof: Float64Array, p: number): { strength: number; phase: number } {
  let re = 0;
  let im = 0;
  let total = 0;
  const w = (2 * Math.PI) / p;
  for (let x = 0; x < prof.length; x++) {
    const v = prof[x];
    if (!v) continue;
    re += v * Math.cos(w * x);
    im += v * Math.sin(w * x);
    total += v;
  }
  if (!total) return { strength: 0, phase: 0 };
  // Lines sit where the cosine peaks: x = phase + k p.
  const phase = ((((Math.atan2(im, re) / (2 * Math.PI)) * p) % p) + p) % p;
  return { strength: Math.hypot(re, im) / total, phase };
}

/** The strongest period within half a percent of `around`. */
function refinePitch(prof: Float64Array, around: number): number {
  let refined = around;
  let strongest = 0;
  for (let p = around * 0.995; p <= around * 1.005; p += around * 0.0002) {
    const s = fourier(prof, p).strength;
    if (s > strongest) [refined, strongest] = [p, s];
  }
  return refined;
}

/**
 * The grid's pitch: the period at which line pixels repeat most strongly. Every fraction of
 * the true pitch (p/2, p/3 ...) repeats as strongly, so the longest strong period wins.
 */
function findPitch(prof: Float64Array): number | null {
  const maxP = Math.min(250, prof.length / 8);
  const scores: Array<[number, number]> = [];
  for (let p = MIN_PITCH; p <= maxP; p *= 1.002) {
    scores.push([p, fourier(prof, p).strength]);
  }
  const best = Math.max(0, ...scores.map((s) => s[1]));
  if (best < 0.2) return null;
  let chosen = 0;
  for (let k = 1; k < scores.length - 1; k++) {
    const [p, s] = scores[k];
    if (s >= 0.85 * best && s >= scores[k - 1][1] && s >= scores[k + 1][1]) chosen = p;
  }
  if (!chosen) return null;
  // Refine around the chosen period.
  let refined = chosen;
  let strongest = 0;
  for (let p = chosen * 0.995; p <= chosen * 1.005; p += chosen * 0.0002) {
    const s = fourier(prof, p).strength;
    if (s > strongest) [refined, strongest] = [p, s];
  }
  return refined;
}

// ---- regions ------------------------------------------------------------------------------

interface Region {
  /** Pixels per grid cell on each axis. */
  px: number;
  py: number;
  /** Pixel of lattice line 0 on each axis. */
  ox: number;
  oy: number;
  /** Lattice cells covered by the region's box, from (i0, j0). */
  i0: number;
  j0: number;
  cols: number;
  rows: number;
  /** Per cell of the box: 1 drawn grid, 0 not. */
  grid: Uint8Array;
  gridCells: number;
}

function findRegion(
  img: RgbImage,
  vertical: Uint8Array,
  horizontal: Uint8Array,
  pitchX: number,
  pitchY: number,
): Region | null {
  let best: Region | null = null;
  for (const [ox, oy] of candidatePhases(
    vertical,
    horizontal,
    img.width,
    img.height,
    pitchX,
    pitchY,
  )) {
    const region = regionAt(img, vertical, horizontal, pitchX, pitchY, ox, oy);
    if (region && (!best || region.gridCells > best.gridCells)) best = region;
  }
  return best;
}

/**
 * Where the lattice may sit. Measured on small tiles rather than the whole sheet: once the
 * main hall is found, the lines left over are mostly rooms, stairs and the legend, and a part
 * of the hall drawn on a shifted grid would be outvoted by them.
 */
function candidatePhases(
  vertical: Uint8Array,
  horizontal: Uint8Array,
  W: number,
  H: number,
  pitchX: number,
  pitchY: number,
): Array<[number, number]> {
  const tile = Math.round(8 * Math.max(pitchX, pitchY));
  // Whole pixels: a fractional start would make every index below fractional (and slow).
  const step = Math.max(1, Math.floor(tile / 2));
  const found: Array<{ ox: number; oy: number; score: number }> = [];
  for (let ty = 0; ty < H; ty += step) {
    for (let tx = 0; tx < W; tx += step) {
      const x1 = Math.min(W, tx + tile);
      const y1 = Math.min(H, ty + tile);
      // Profiles are indexed from the tile's corner; phases are shifted back below.
      const px = new Float64Array(x1 - tx);
      const py = new Float64Array(y1 - ty);
      let n = 0;
      for (let y = ty; y < y1; y++) {
        for (let x = tx; x < x1; x++) {
          const i = y * W + x;
          if (vertical[i]) {
            px[x - tx]++;
            n++;
          }
          if (horizontal[i]) {
            py[y - ty]++;
            n++;
          }
        }
      }
      // A tile of grid holds about two lines per pitch along each side.
      if (n < (tile * tile) / Math.max(pitchX, pitchY)) continue;
      const fx = fourier(px, pitchX);
      const fy = fourier(py, pitchY);
      const score = Math.min(fx.strength, fy.strength);
      if (score < 0.6) continue;
      found.push({
        ox: (fx.phase + tx) % pitchX,
        oy: (fy.phase + ty) % pitchY,
        score: score * Math.sqrt(n),
      });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const near = (a: number, b: number, p: number) => {
    const d = Math.abs(a - b) % p;
    return Math.min(d, p - d) < 1;
  };
  const out: Array<[number, number]> = [];
  for (const f of found) {
    if (out.some(([x, y]) => near(x, f.ox, pitchX) && near(y, f.oy, pitchY))) continue;
    out.push([f.ox, f.oy]);
    if (out.length === 4) break;
  }
  return out;
}

function regionAt(
  img: RgbImage,
  vertical: Uint8Array,
  horizontal: Uint8Array,
  pitchX: number,
  pitchY: number,
  ox: number,
  oy: number,
): Region | null {
  const W = img.width;
  const H = img.height;
  const cols = Math.floor((W - 1 - ox) / pitchX);
  const rows = Math.floor((H - 1 - oy) / pitchY);
  if (cols < 2 || rows < 2) return null;

  const covered = (mask: Uint8Array, isVertical: boolean, at: number, from: number, to: number) => {
    let hit = 0;
    let n = 0;
    const c = Math.round(at);
    for (let t = Math.ceil(from + 1); t <= Math.floor(to - 1); t++) {
      n++;
      for (let d = -1; d <= 1; d++) {
        const cc = c + d;
        if (cc < 0 || cc >= (isVertical ? W : H)) continue;
        if (mask[isVertical ? t * W + cc : cc * W + t]) {
          hit++;
          break;
        }
      }
    }
    return n ? hit / n : 0;
  };

  const grid = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const xa = ox + i * pitchX;
      const xb = xa + pitchX;
      const ya = oy + j * pitchY;
      const yb = ya + pitchY;
      let sides = 0;
      if (covered(vertical, true, xa, ya, yb) >= SIDE_COVERAGE) sides++;
      if (covered(vertical, true, xb, ya, yb) >= SIDE_COVERAGE) sides++;
      if (covered(horizontal, false, ya, xa, xb) >= SIDE_COVERAGE) sides++;
      if (sides >= 2 && covered(horizontal, false, yb, xa, xb) >= SIDE_COVERAGE) sides++;
      if (sides >= 3) grid[j * cols + i] = 1;
    }
  }

  // Keep only connected areas of grid large enough to be part of a hall.
  const keep = new Uint8Array(cols * rows);
  let kept = 0;
  for (const component of components(grid, cols, rows, (v) => v === 1)) {
    if (component.length < MIN_REGION_CELLS) continue;
    for (const k of component) keep[k] = 1;
    kept += component.length;
  }
  if (!kept) return null;

  let minI = cols;
  let minJ = rows;
  let maxI = -1;
  let maxJ = -1;
  for (let k = 0; k < keep.length; k++) {
    if (!keep[k]) continue;
    const i = k % cols;
    const j = (k - i) / cols;
    minI = Math.min(minI, i);
    maxI = Math.max(maxI, i);
    minJ = Math.min(minJ, j);
    maxJ = Math.max(maxJ, j);
  }
  // The box reaches a few cells past the grid, where bands along its edge may lie.
  const pad = 3;
  const i0 = Math.max(0, minI - pad);
  const j0 = Math.max(0, minJ - pad);
  const i1 = Math.min(cols - 1, maxI + pad);
  const j1 = Math.min(rows - 1, maxJ + pad);
  const boxCols = i1 - i0 + 1;
  const boxRows = j1 - j0 + 1;
  const boxGrid = new Uint8Array(boxCols * boxRows);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) boxGrid[(j - j0) * boxCols + (i - i0)] = keep[j * cols + i];
  }
  return {
    px: pitchX,
    py: pitchY,
    ox,
    oy,
    i0,
    j0,
    cols: boxCols,
    rows: boxRows,
    grid: boxGrid,
    gridCells: kept,
  };
}

/** Removes a found region's lines, so the next pass finds the rest of the hall. */
function clearRegion(
  region: Region,
  vertical: Uint8Array,
  horizontal: Uint8Array,
  W: number,
  H: number,
): void {
  for (let j = 0; j < region.rows; j++) {
    for (let i = 0; i < region.cols; i++) {
      if (!region.grid[j * region.cols + i]) continue;
      const [xa, xb, ya, yb] = cellPixels(region, i, j);
      for (let y = Math.max(0, ya - 1); y <= Math.min(H - 1, yb + 1); y++) {
        for (let x = Math.max(0, xa - 1); x <= Math.min(W - 1, xb + 1); x++) {
          vertical[y * W + x] = 0;
          horizontal[y * W + x] = 0;
        }
      }
    }
  }
}

/** Pixel box of cell (i, j) of a region's box, inclusive. */
function cellPixels(region: Region, i: number, j: number): [number, number, number, number] {
  const xa = Math.round(region.ox + (region.i0 + i) * region.px);
  const ya = Math.round(region.oy + (region.j0 + j) * region.py);
  return [xa, Math.round(xa + region.px), ya, Math.round(ya + region.py)];
}

// ---- colours ------------------------------------------------------------------------------

export type ColorFamily =
  | 'white'
  | 'sparse'
  | 'dark'
  | 'grey'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'magenta';

/**
 * What a colour most often means on exhibition plans, used only when the plan's own legend does
 * not say. It is a guess: the review screen marks it as one.
 */
const FAMILY_KIND: Record<Exclude<ColorFamily, 'white' | 'sparse'>, FloorAreaKind> = {
  dark: 'wall',
  grey: 'column',
  red: 'passage',
  orange: 'no_build',
  yellow: 'unavailable',
  green: 'entry',
  blue: 'utility',
  purple: 'fire_curtain',
  magenta: 'marking',
};

interface CellColor {
  family: ColorFamily;
  /** Mean colour of the cell's painted pixels. */
  r: number;
  g: number;
  b: number;
}

/** The broad colour family of one RGB colour. */
export function colorFamily(r: number, g: number, b: number): ColorFamily {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const sat = max ? (max - min) / max : 0;
  if (sat < 0.18) return lum < 90 ? 'dark' : lum > 235 ? 'white' : 'grey';
  let h: number;
  const d = max - min;
  if (max === r) h = (((g - b) / d) % 6) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  if (h < 0) h += 360;
  if (h < 18 || h >= 340) return 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 165) return 'green';
  if (h < 245) return 'blue';
  if (h < 290) return 'purple';
  return 'magenta';
}

/** Colour of every cell of every region's box, from its inner pixels. */
function cellColors(img: RgbImage, regions: Region[]): CellColor[][] {
  const { width: W, height: H, data } = img;
  return regions.map((region) => {
    const out: CellColor[] = [];
    for (let j = 0; j < region.rows; j++) {
      for (let i = 0; i < region.cols; i++) {
        const [xa, xb, ya, yb] = cellPixels(region, i, j);
        let n = 0;
        let painted = 0;
        const tally = new Map<ColorFamily, { n: number; r: number; g: number; b: number }>();
        for (let y = Math.max(0, ya + 1); y <= Math.min(H - 1, yb - 1); y++) {
          for (let x = Math.max(0, xa + 1); x <= Math.min(W - 1, xb - 1); x++) {
            const k = 3 * (y * W + x);
            n++;
            const pr = data[k];
            const pg = data[k + 1];
            const pb = data[k + 2];
            const family = colorFamily(pr, pg, pb);
            if (family === 'white') continue;
            painted++;
            let t = tally.get(family);
            if (!t) tally.set(family, (t = { n: 0, r: 0, g: 0, b: 0 }));
            t.n++;
            t.r += pr;
            t.g += pg;
            t.b += pb;
          }
        }
        // The most common colour wins: hatching mixes two colours, an average makes a third.
        const top = [...tally].sort((a, b) => b[1].n - a[1].n)[0];
        // A band of colour counts from a quarter of the cell: a 1 m band laid between grid
        // lines covers half of each of two cells. Dark and grey need half the cell, so that
        // text, symbols and lines drawn on the grid do not read as bands.
        const need = top && (top[0] === 'dark' || top[0] === 'grey') ? 0.5 : 0.25;
        if (!n || !top || top[1].n / n < need) {
          out.push({ family: painted ? 'sparse' : 'white', r: 255, g: 255, b: 255 });
        } else {
          const [family, t] = top;
          out.push({ family, r: t.r / t.n, g: t.g / t.n, b: t.b / t.n });
        }
      }
    }
    return out;
  });
}

/**
 * Decides which painted cells next to the grid belong to the hall. A band of one colour joins
 * when a good part of its edge runs along the floor (a passage strip at the wall, a fire
 * curtain across the hall), or when the floor surrounds it. Unpainted gaps the floor surrounds
 * (text, symbols drawn on the grid) are floor.
 *
 * Returns, per accepted non-grid cell of the box, its colour family ('sparse' means plain floor).
 */
function acceptOverlays(region: Region, colors: CellColor[]): Map<number, ColorFamily> {
  const { cols, rows, grid } = region;
  const accepted = new Map<number, ColorFamily>();
  const painted = (k: number) => {
    const f = colors[k].family;
    return f !== 'white' && f !== 'sparse';
  };

  // Hatched bands let the grid show through: a grid cell filled with colour is that band.
  for (let k = 0; k < grid.length; k++) {
    if (grid[k] && painted(k)) accepted.set(k, colors[k].family);
  }

  const isFloor = (k: number) => grid[k] === 1 || accepted.has(k);
  for (let pass = 0; pass < 4; pass++) {
    let added = false;
    const candidates = new Uint8Array(cols * rows);
    for (let k = 0; k < candidates.length; k++) {
      if (!isFloor(k) && colors[k].family !== 'white') candidates[k] = 1;
    }
    for (const component of components(
      candidates,
      cols,
      rows,
      (v) => v === 1,
      (k) => colors[k].family,
    )) {
      let sides = 0;
      let gridSides = 0;
      let floorSides = 0;
      let touchesBorder = false;
      const inComponent = new Set(component);
      for (const k of component) {
        const i = k % cols;
        const j = (k - i) / cols;
        if (i === 0 || j === 0 || i === cols - 1 || j === rows - 1) touchesBorder = true;
        for (const n of neighbours(i, j, cols, rows)) {
          if (inComponent.has(n)) continue;
          sides++;
          if (grid[n]) gridSides++;
          if (isFloor(n)) floorSides++;
        }
      }
      const family = colors[component[0]].family;
      const enclosed = !touchesBorder && sides > 0 && floorSides === sides;
      // A band joins along the drawn grid itself, never along another band: walls, doors and
      // rooms beyond a hall's edge strip stay outside. Text and symbols drawn on the grid
      // join only where the grid (nearly) surrounds them.
      const ok =
        family === 'sparse'
          ? sides > 0 && gridSides / sides >= 0.75
          : enclosed || (pass === 0 && sides > 0 && gridSides / sides >= 0.3);
      if (!ok) continue;
      for (const k of component) accepted.set(k, family);
      added = true;
    }
    if (!added) break;
  }

  // Unpainted holes inside the floor: small ones are the grid with a lost line.
  const empty = new Uint8Array(cols * rows);
  for (let k = 0; k < empty.length; k++) if (!isFloor(k)) empty[k] = 1;
  for (const component of components(empty, cols, rows, (v) => v === 1)) {
    if (component.length > 4) continue;
    const inComponent = new Set(component);
    let enclosed = true;
    for (const k of component) {
      const i = k % cols;
      const j = (k - i) / cols;
      if (i === 0 || j === 0 || i === cols - 1 || j === rows - 1) enclosed = false;
      for (const n of neighbours(i, j, cols, rows)) {
        if (!inComponent.has(n) && !isFloor(n)) enclosed = false;
      }
    }
    if (enclosed) for (const k of component) accepted.set(k, 'sparse');
  }
  return accepted;
}

// ---- cell map -----------------------------------------------------------------------------

/**
 * The regions' floor on one map, in grid cells subdivided `sub` times. Each map cell is read
 * from the plan's pixels: a band's own colour where the band is drawn, plain floor elsewhere.
 * Colour counts only near cells accepted as that band, so stall outlines and symbols drawn on
 * the grid do not become areas.
 */
function toCellMap(
  img: RgbImage,
  regions: Region[],
  families: Array<Map<number, ColorFamily>>,
  pitchX: number,
  pitchY: number,
  warnings: string[],
): PlanMap {
  const main = regions[0];
  const sub = Math.max(1, Math.min(MAX_SUB, Math.floor(Math.min(pitchX, pitchY))));
  // Where each region's lattice sits against the main one, in map cells.
  const offset = (r: Region) => ({
    dx: Math.round(((r.ox - main.ox) / pitchX) * sub),
    dy: Math.round(((r.oy - main.oy) / pitchY) * sub),
  });
  const isFloorCell = (ri: number, k: number) => regions[ri].grid[k] === 1 || families[ri].has(k);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [ri, region] of regions.entries()) {
    const { dx, dy } = offset(region);
    for (let j = 0; j < region.rows; j++) {
      for (let i = 0; i < region.cols; i++) {
        if (!isFloorCell(ri, j * region.cols + i)) continue;
        const x = (region.i0 + i) * sub + dx;
        const y = (region.j0 + j) * sub + dy;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + sub);
        maxY = Math.max(maxY, y + sub);
      }
    }
  }
  const cols = maxX - minX;
  const rows = maxY - minY;
  const cells = new Int16Array(cols * rows).fill(OUTSIDE);
  const regionOf = new Uint8Array(cols * rows).fill(255);

  const groupOf = new Map<
    ColorFamily,
    { id: number; r: number; g: number; b: number; n: number }
  >();
  const groupFor = (family: ColorFamily) => {
    let group = groupOf.get(family);
    if (!group) groupOf.set(family, (group = { id: groupOf.size, r: 0, g: 0, b: 0, n: 0 }));
    return group;
  };
  const { width: W, height: H, data } = img;

  for (const [ri, region] of regions.entries()) {
    const { dx, dy } = offset(region);
    const fams = families[ri];
    const banded = (k: number) => {
      const f = fams.get(k);
      return f && f !== 'sparse' && f !== 'white' ? f : null;
    };
    for (let j = 0; j < region.rows; j++) {
      for (let i = 0; i < region.cols; i++) {
        const k = j * region.cols + i;
        if (!isFloorCell(ri, k)) continue;
        // Bands that may reach into this cell: its own, and its neighbours'.
        const near = new Set<ColorFamily>();
        for (let nj = Math.max(0, j - 1); nj <= Math.min(region.rows - 1, j + 1); nj++) {
          for (let ni = Math.max(0, i - 1); ni <= Math.min(region.cols - 1, i + 1); ni++) {
            const f = banded(nj * region.cols + ni);
            if (f) near.add(f);
          }
        }
        const x0 = (region.i0 + i) * sub + dx - minX;
        const y0 = (region.j0 + j) * sub + dy - minY;
        for (let v = 0; v < sub; v++) {
          for (let u = 0; u < sub; u++) {
            const idx = (y0 + v) * cols + (x0 + u);
            let value = FLOOR;
            if (near.size) {
              const px = Math.floor(region.ox + (region.i0 + i + (u + 0.5) / sub) * pitchX);
              const py = Math.floor(region.oy + (region.j0 + j + (v + 0.5) / sub) * pitchY);
              if (px >= 0 && py >= 0 && px < W && py < H) {
                const q = 3 * (py * W + px);
                const family = colorFamily(data[q], data[q + 1], data[q + 2]);
                if (near.has(family)) {
                  const group = groupFor(family);
                  const bucket = ((data[q] >> 4) << 8) | ((data[q + 1] >> 4) << 4) | (data[q + 2] >> 4);
                  const b = group.buckets.get(bucket) ?? { n: 0, r: 0, g: 0, b: 0 };
                  b.n++;
                  b.r += data[q];
                  b.g += data[q + 1];
                  b.b += data[q + 2];
                  group.buckets.set(bucket, b);
                  value = group.id;
                }
              }
            }
            // Where two parts' lattices touch, the drawn grid wins over a band.
            if (cells[idx] === FLOOR && value !== FLOOR) continue;
            cells[idx] = value;
            regionOf[idx] = Math.min(254, ri);
          }
        }
      }
    }
  }

  if (sub >= 3) {
    cleanBands(cells, cols, rows);
    smoothBands(cells, cols, rows);
    dropSpecks(cells, cols, rows, Math.max(4, Math.floor((sub * sub) / 4)));
  }
  squareBands(cells, cols, rows);

  const groups: OverlayGroup[] = [...groupOf]
    .map(([family, g]) => {
      const hex = (v: number) =>
        Math.round(v / Math.max(1, g.n))
          .toString(16)
          .padStart(2, '0');
      let count = 0;
      for (const v of cells) if (v === g.id) count++;
      return {
        id: g.id,
        color: `#${hex(g.r)}${hex(g.g)}${hex(g.b)}`,
        family,
        kind: FAMILY_KIND[family as keyof typeof FAMILY_KIND],
        cells: count,
      };
    })
    .filter((g) => g.cells > 0);

  return {
    source: 'grid',
    sub,
    cols,
    rows,
    cells,
    groups,
    unitPxX: pitchX,
    unitPxY: pitchY,
    originX: main.ox + (minX / sub) * pitchX,
    originY: main.oy + (minY / sub) * pitchY,
    gridCells: regions.reduce((n, r) => n + r.gridCells, 0),
    regions: regions.length,
    regionOf,
    warnings,
  };
}

/**
 * Smooths band edges read pixel by pixel: a cell takes the value most of its eight neighbours
 * have, when at least five agree. Floor outside the hall never changes.
 */
function smoothBands(cells: Int16Array, cols: number, rows: number): void {
  for (let pass = 0; pass < 2; pass++) {
    const next = Int16Array.from(cells);
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const k = y * cols + x;
        if (cells[k] === OUTSIDE) continue;
        const counts = new Map<number, number>();
        for (const n of [
          k - cols - 1,
          k - cols,
          k - cols + 1,
          k - 1,
          k + 1,
          k + cols - 1,
          k + cols,
          k + cols + 1,
        ]) {
          const v = cells[n];
          if (v === OUTSIDE) continue;
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        for (const [v, n] of counts) {
          if (n >= 5 && v !== cells[k]) {
            next[k] = v;
            break;
          }
        }
      }
    }
    cells.set(next);
  }
}

/** Band pieces smaller than `min` cells are stray pixels (a grid line beside a column): floor. */
function dropSpecks(cells: Int16Array, cols: number, rows: number, min: number): void {
  const seen = new Uint8Array(cells.length);
  const stack: number[] = [];
  for (let start = 0; start < cells.length; start++) {
    const v = cells[start];
    if (v < 0 || seen[start]) continue;
    const members: number[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      members.push(k);
      const x = k % cols;
      for (const n of [x > 0 ? k - 1 : -1, x < cols - 1 ? k + 1 : -1, k - cols, k + cols]) {
        if (n < 0 || n >= cells.length || seen[n] || cells[n] !== v) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (members.length < min) for (const k of members) cells[k] = FLOOR;
  }
  void rows;
}

/**
 * A band that fills nearly all of its bounding box is a rectangle on the plan (a passage, a
 * column, a curtain); its ragged pixel edge is replaced by the rectangle. Other shapes keep the
 * shape they were drawn with.
 */
function squareBands(cells: Int16Array, cols: number, rows: number): void {
  const seen = new Uint8Array(cells.length);
  const stack: number[] = [];
  for (let start = 0; start < cells.length; start++) {
    const v = cells[start];
    if (v < 0 || seen[start]) continue;
    const members: number[] = [];
    let [x0, y0, x1, y1] = [cols, rows, -1, -1];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      members.push(k);
      const x = k % cols;
      const y = (k - x) / cols;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const n of [x > 0 ? k - 1 : -1, x < cols - 1 ? k + 1 : -1, k - cols, k + cols]) {
        if (n < 0 || n >= cells.length || seen[n] || cells[n] !== v) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    const box = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (members.length < 4 || members.length < 0.8 * box) continue;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = y * cols + x;
        // Fill only plain floor: never another band, never outside the hall.
        if (cells[k] === FLOOR) cells[k] = v;
      }
    }
  }
}

/**
 * Tidies bands read pixel by pixel: grid lines crossing a band are filled in (closing), and
 * slivers one map cell thin, such as a stall outline beside a band, are removed (opening).
 */
function cleanBands(cells: Int16Array, cols: number, rows: number): void {
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= cols || y >= rows ? OUTSIDE : cells[y * cols + x];
  // Closing: floor surrounded on three or four sides by one band becomes that band.
  for (let pass = 0; pass < 2; pass++) {
    const fill: Array<[number, number]> = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (cells[y * cols + x] !== FLOOR) continue;
        const n = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].filter((v) => v >= 0);
        for (const v of n) {
          if (n.filter((w) => w === v).length >= 3) {
            fill.push([y * cols + x, v]);
            break;
          }
        }
      }
    }
    for (const [idx, v] of fill) cells[idx] = v;
  }
  // Opening: keep band cells whose four neighbours are the same band, then grow them back.
  const keep = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = cells[y * cols + x];
      if (v < 0) continue;
      if (at(x - 1, y) === v && at(x + 1, y) === v && at(x, y - 1) === v && at(x, y + 1) === v) {
        keep[y * cols + x] = 1;
      }
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const idx = y * cols + x;
      const v = cells[idx];
      if (v < 0 || keep[idx]) continue;
      const grown =
        (x > 0 && keep[idx - 1] && cells[idx - 1] === v) ||
        (x < cols - 1 && keep[idx + 1] && cells[idx + 1] === v) ||
        (y > 0 && keep[idx - cols] && cells[idx - cols] === v) ||
        (y < rows - 1 && keep[idx + cols] && cells[idx + cols] === v);
      if (!grown) cells[idx] = FLOOR;
    }
  }
}

/** What a group of the map becomes: an area kind, plain floor, or outside the hall. */
export type GroupChoice = FloorAreaKind | 'floor';

/**
 * The map as ITPO-style rectangles: `outside` where there is no hall, typed areas where bands
 * lie on the floor. Equal runs on consecutive rows are merged, so a straight wall or band is
 * one rectangle.
 */
export function mapAreas(
  map: Pick<PlanMap, 'cols' | 'rows' | 'cells' | 'groups'>,
  choices: ReadonlyMap<number, GroupChoice>,
  /** Metres per map cell. */
  resolution: number,
): FloorArea[] {
  const { cols, rows, cells } = map;
  const kindAt = (v: number): FloorAreaKind | null => {
    if (v === OUTSIDE) return 'outside';
    if (v === FLOOR) return null;
    const choice = choices.get(v) ?? map.groups.find((g) => g.id === v)?.kind ?? 'unavailable';
    return choice === 'floor' ? null : choice;
  };
  const colorOf = new Map(map.groups.map((g) => [g.id, g.color]));

  interface Open {
    x0: number;
    x1: number;
    y0: number;
    value: number;
    kind: FloorAreaKind;
  }
  const out: FloorArea[] = [];
  let open = new Map<string, Open>();
  const close = (o: Open, y1: number) => {
    const area: FloorArea = {
      kind: o.kind,
      x: round(o.x0 * resolution),
      y: round(o.y0 * resolution),
      width: round((o.x1 - o.x0) * resolution),
      height: round((y1 - o.y0) * resolution),
    };
    if (o.kind === 'outside') area.color = '#ffffff';
    else if (o.value >= 0 && colorOf.has(o.value)) area.color = colorOf.get(o.value);
    out.push(area);
  };
  for (let y = 0; y <= rows; y++) {
    const next = new Map<string, Open>();
    if (y < rows) {
      let x = 0;
      while (x < cols) {
        const v = cells[y * cols + x];
        const kind = kindAt(v);
        let end = x + 1;
        while (end < cols && cells[y * cols + end] === v) end++;
        if (kind) {
          const key = `${x}:${end}:${v}`;
          const prev = open.get(key);
          next.set(key, prev ?? { x0: x, x1: end, y0: y, value: v, kind });
          open.delete(key);
        }
        x = end;
      }
    }
    for (const o of open.values()) close(o, y);
    open = next;
  }
  return out;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

// ---- small helpers ------------------------------------------------------------------------

function neighbours(i: number, j: number, cols: number, rows: number): number[] {
  const out: number[] = [];
  if (i > 0) out.push(j * cols + i - 1);
  if (i < cols - 1) out.push(j * cols + i + 1);
  if (j > 0) out.push((j - 1) * cols + i);
  if (j < rows - 1) out.push((j + 1) * cols + i);
  return out;
}

/** 4-connected components of the cells `take` accepts, optionally split by `key`. */
function components(
  values: Uint8Array,
  cols: number,
  rows: number,
  take: (v: number) => boolean,
  key?: (k: number) => string,
): number[][] {
  const seen = new Uint8Array(values.length);
  const out: number[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < values.length; start++) {
    if (seen[start] || !take(values[start])) continue;
    const label = key?.(start);
    const component: number[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      component.push(k);
      const i = k % cols;
      const j = (k - i) / cols;
      for (const n of neighbours(i, j, cols, rows)) {
        if (seen[n] || !take(values[n]) || (key && key(n) !== label)) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    out.push(component);
  }
  return out;
}
