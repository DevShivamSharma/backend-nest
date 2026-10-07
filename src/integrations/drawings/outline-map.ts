import { colorFamily, ColorFamily, FLOOR, OUTSIDE, OverlayGroup, PlanMap } from './grid-map';
import type { RgbImage } from './raster';

/**
 * For plans without a stall grid: rooms enclosed by drawn lines. The map unit is a fixed number
 * of pixels, so nothing here claims a size in metres; the scale must come from the plan's
 * dimension lines or from the person importing. The boundaries are a proposal to confirm: a
 * line drawing does not say which enclosed shape is the hall.
 */

/** Enclosed shapes smaller than this share of the sheet are rooms, symbols or text. */
const MIN_ROOM_SHARE = 0.004;
/** The map has at most this many cells across. */
const MAX_COLS = 1200;
/** Colours this family become no area: lines and text. */
const INKS: ReadonlySet<ColorFamily> = new Set(['white', 'sparse', 'dark']);

/** Fallback guesses for colours, as on gridded plans. */
const FAMILY_KIND: Partial<Record<ColorFamily, OverlayGroup['kind']>> = {
  grey: 'column',
  red: 'passage',
  orange: 'no_build',
  yellow: 'unavailable',
  green: 'entry',
  blue: 'utility',
  purple: 'fire_curtain',
  magenta: 'marking',
};

export function analyseOutlines(img: RgbImage): PlanMap {
  const unit = Math.max(1, Math.ceil(Math.max(img.width, img.height) / MAX_COLS));
  const cols = Math.ceil(img.width / unit);
  const rows = Math.ceil(img.height / unit);

  // A map cell is a barrier when it holds dark ink: walls and lines enclose rooms.
  const barrier = new Uint8Array(cols * rows);
  const tally: Array<Map<ColorFamily, number>> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const counts = new Map<ColorFamily, number>();
      let dark = 0;
      let n = 0;
      for (let y = r * unit; y < Math.min(img.height, (r + 1) * unit); y++) {
        for (let x = c * unit; x < Math.min(img.width, (c + 1) * unit); x++) {
          const k = 3 * (y * img.width + x);
          const lum = 0.299 * img.data[k] + 0.587 * img.data[k + 1] + 0.114 * img.data[k + 2];
          n++;
          if (lum < 110) dark++;
          const f = colorFamily(img.data[k], img.data[k + 1], img.data[k + 2]);
          counts.set(f, (counts.get(f) ?? 0) + 1);
        }
      }
      if (dark > 0) barrier[r * cols + c] = 1;
      tally.push(counts);
      void n;
    }
  }

  // Outside: reachable from the sheet's edge without crossing ink.
  const outside = new Uint8Array(cols * rows);
  const stack: number[] = [];
  const push = (k: number) => {
    if (!outside[k] && !barrier[k]) {
      outside[k] = 1;
      stack.push(k);
    }
  };
  for (let c = 0; c < cols; c++) {
    push(c);
    push((rows - 1) * cols + c);
  }
  for (let r = 0; r < rows; r++) {
    push(r * cols);
    push(r * cols + cols - 1);
  }
  while (stack.length) {
    const k = stack.pop()!;
    const c = k % cols;
    if (c > 0) push(k - 1);
    if (c < cols - 1) push(k + 1);
    if (k >= cols) push(k - cols);
    if (k < (rows - 1) * cols) push(k + cols);
  }

  // Rooms: enclosed open space large enough to be a hall or a foyer.
  const cells = new Int16Array(cols * rows).fill(OUTSIDE);
  const seen = new Uint8Array(cols * rows);
  const minCells = MIN_ROOM_SHARE * cols * rows;
  for (let start = 0; start < cells.length; start++) {
    if (seen[start] || outside[start] || barrier[start]) continue;
    const room: number[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      room.push(k);
      const c = k % cols;
      for (const n of [c > 0 ? k - 1 : -1, c < cols - 1 ? k + 1 : -1, k - cols, k + cols]) {
        if (n < 0 || n >= cells.length || seen[n] || outside[n] || barrier[n]) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (room.length >= minCells) for (const k of room) cells[k] = FLOOR;
  }

  // Ink inside a room (text, symbols, thin lines) is floor when the room surrounds it.
  for (let pass = 0; pass < 3; pass++) {
    const fill: number[] = [];
    for (let k = 0; k < cells.length; k++) {
      if (cells[k] !== OUTSIDE || outside[k]) continue;
      const c = k % cols;
      let floorSides = 0;
      for (const n of [c > 0 ? k - 1 : -1, c < cols - 1 ? k + 1 : -1, k - cols, k + cols]) {
        if (n >= 0 && n < cells.length && cells[n] === FLOOR) floorSides++;
      }
      if (floorSides >= 3) fill.push(k);
    }
    for (const k of fill) cells[k] = FLOOR;
  }

  // Colour fills on the floor become overlay groups.
  const groups = new Map<ColorFamily, OverlayGroup>();
  for (let k = 0; k < cells.length; k++) {
    if (cells[k] !== FLOOR) continue;
    let best: ColorFamily | null = null;
    let most = 0;
    let total = 0;
    for (const [f, n] of tally[k]) {
      total += n;
      if (!INKS.has(f) && n > most) [best, most] = [f, n];
    }
    if (!best || most < 0.5 * total) continue;
    let group = groups.get(best);
    if (!group) {
      group = {
        id: groups.size,
        color: '#888888',
        family: best,
        kind: FAMILY_KIND[best] ?? 'marking',
        cells: 0,
      };
      groups.set(best, group);
    }
    group.cells++;
    cells[k] = group.id;
  }
  // Colour each group by a sample of its pixels.
  for (const group of groups.values()) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let k = 0; k < cells.length && n < 2000; k++) {
      if (cells[k] !== group.id) continue;
      const x = Math.min(img.width - 1, (k % cols) * unit + Math.floor(unit / 2));
      const y = Math.min(img.height - 1, Math.floor(k / cols) * unit + Math.floor(unit / 2));
      const q = 3 * (y * img.width + x);
      r += img.data[q];
      g += img.data[q + 1];
      b += img.data[q + 2];
      n++;
    }
    const hex = (v: number) =>
      Math.round(v / Math.max(1, n))
        .toString(16)
        .padStart(2, '0');
    group.color = `#${hex(r)}${hex(g)}${hex(b)}`;
  }

  return {
    source: 'outline',
    sub: 1,
    cols,
    rows,
    cells,
    groups: [...groups.values()],
    unitPxX: unit,
    unitPxY: unit,
    originX: 0,
    originY: 0,
    gridCells: 0,
    regions: 0,
    regionOf: Uint8Array.from(cells, (v) => (v === OUTSIDE ? 255 : 0)),
    warnings: [
      'No stall grid was found: the floor is the enclosed space between drawn lines. Check each hall’s boundary, and set the scale from a dimension or a known length.',
    ],
  };
}
