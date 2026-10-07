/**
 * Our own description of a hall's empty floor, the same for every venue system. A venue's
 * format (ITPO's `T_HALL_LAYOUTS`, a DXF drawing...) is converted into this by an adapter, and
 * everything after that (planning, rules, publishing) reads only this.
 *
 * Units are metres. The origin is the top-left corner of the hall's extent, x to the right and
 * y downwards, as on a drawing. Geometry may reach outside `width` x `depth`: venues draw walls
 * and foyers past their nominal size, and nothing is clipped.
 */
export const FLOOR_SCHEMA = 'floor/1' as const;

/** The largest hall side we accept, in metres. Bharat Mandapam's largest is 260 m. */
export const MAX_HALL_SIDE = 2000;
const MAX_AREAS = 10_000;
const MAX_LABELS = 2_000;
const MAX_TEXT = 200;

/**
 * What a rectangle of the floor is. The kind decides whether stalls may stand on it
 * (see {@link blocksStalls}); its colour is only how the venue drew it.
 */
export type FloorAreaKind =
  | 'outside' // not part of the hall: the space around an irregular outline
  | 'wall'
  | 'column' // a pillar; stalls may be built around one
  | 'passage' // a compulsory passage for entry, exit or services
  | 'fire_curtain' // nothing may be built below it
  | 'no_build' // any other no-construction zone
  | 'utility' // electrical panel, hydrant, service point
  | 'entry' // a main entry or exit that must stay clear
  | 'unavailable' // floor the venue does not let for exhibitions
  | 'void' // a hole in the floor inside the hall's outline (shaft, courtyard, atrium void)
  | 'facility' // a built room inside the hall: stairs, lift, toilets, store; `label` says which
  | 'marking'; // drawn by the venue with no stated meaning; never blocks

export const FLOOR_AREA_KINDS: readonly FloorAreaKind[] = [
  'outside',
  'wall',
  'column',
  'passage',
  'fire_curtain',
  'no_build',
  'utility',
  'entry',
  'unavailable',
  'void',
  'facility',
  'marking',
];

export interface FloorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloorArea extends FloorRect {
  kind: FloorAreaKind;
  /** The venue's own name for it, e.g. "Pillar". */
  label?: string;
  /** How the venue drew it: a CSS colour. */
  color?: string;
  /** Present but not shown on the published plan (ITPO's fire curtains). Still blocks. */
  hidden?: boolean;
}

/** A text on the plan, e.g. a gate name. `x`, `y` are its top-left corner. */
export interface FloorLabel {
  text: string;
  x: number;
  y: number;
}

/** A card of facility icons drawn side by side (toilets, stairs, exits). Top-left corner. */
export interface FloorIconGroup {
  x: number;
  y: number;
  icons: { kind: string; label: string }[];
}

/** The north arrow: top-left corner, side length in metres, clockwise degrees. */
export interface FloorNorth {
  x: number;
  y: number;
  size: number;
  rotation: number;
  label: string;
}

/** One row of the venue's legend: a colour and what it means, or a code explained. */
export interface FloorLegendEntry {
  label: string;
  color?: string;
  kind?: FloorAreaKind;
  /** A code the row explains, e.g. "GF4-1:". Plain text. */
  code?: string;
  /** False when the venue shows this row only to its own staff. */
  showInView: boolean;
}

/** What a zone of the floor is used for. Zones never block stalls; areas do. */
export type FloorZoneKind = 'foyer' | 'circulation';

export const FLOOR_ZONE_KINDS: readonly FloorZoneKind[] = ['foyer', 'circulation'];

/**
 * A named part of the hall's floor with its own role, e.g. the foyer in front of the hall.
 * Its rectangles lie on the hall's floor, and are counted apart from the stall floor.
 */
export interface FloorZone {
  kind: FloorZoneKind;
  name?: string;
  rects: FloorRect[];
}

/**
 * Where an imported floor came from: its place on the source sheet (in metres of that sheet,
 * after any rotation that squared it up) and how its scale was established.
 */
export interface FloorPlacement {
  file: string;
  /** 1-based page of the source document. */
  page: number;
  /** The hall's (0, 0) on the sheet, in metres. */
  x: number;
  y: number;
  /** Degrees the sheet was turned to square the grid, clockwise. */
  rotation: number;
  /** Metres per grid cell, when the plan has a grid. */
  gridMetres: number | null;
  /** How the scale is known: the evidence, or the person's calibration. */
  scaleSource: string;
}

export interface HallFloor {
  schema: typeof FLOOR_SCHEMA;
  width: number;
  depth: number;
  areas: FloorArea[];
  labels: FloorLabel[];
  iconGroups: FloorIconGroup[];
  north: FloorNorth | null;
  legend: FloorLegendEntry[];
  /** Foyers and circulation on the floor. Absent on floors made before zones existed. */
  zones?: FloorZone[];
  /** Absent unless the floor was imported from a drawing. */
  placement?: FloorPlacement;
}

/** Whether stalls may not stand on an area of this kind. */
export function blocksStalls(kind: FloorAreaKind): boolean {
  // Columns: ITPO's own approved layouts build stalls around them. Markings: no stated meaning.
  return kind !== 'column' && kind !== 'marking';
}

/** An empty rectangular hall. */
export function blankFloor(width: number, depth: number): HallFloor {
  return {
    schema: FLOOR_SCHEMA,
    width,
    depth,
    areas: [],
    labels: [],
    iconGroups: [],
    north: null,
    legend: [],
  };
}

/** Rounds to the millimetre, so values read from pixels or text compare and store cleanly. */
export function mm(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,24})$/;

/** A CSS colour in lower case, or undefined when the value is not a plain colour. */
export function cleanColor(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const color = value
    .trim()
    .toLowerCase()
    .replace(/^grey$/, 'gray');
  return COLOR.test(color) ? color : undefined;
}

/** Plain, trimmed, bounded text; undefined when empty. Markup is never kept. */
export function cleanText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const text = String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : undefined;
}

/** A finite number, or undefined. Accepts numeric strings, as CSV exports give them. */
export function finite(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Checks the limits every stored floor keeps, whatever produced it. Returns the problems. */
export function floorProblems(floor: HallFloor): string[] {
  const problems: string[] = [];
  const side = (value: number) => value > 0 && value <= MAX_HALL_SIDE;
  if (!side(floor.width) || !side(floor.depth)) {
    problems.push(`The hall must measure between 0 and ${MAX_HALL_SIDE} m each way.`);
  }
  if (floor.areas.length > MAX_AREAS) {
    problems.push(`A floor may have at most ${MAX_AREAS} areas.`);
  }
  if (floor.labels.length > MAX_LABELS || floor.iconGroups.length > MAX_LABELS) {
    problems.push(`A floor may have at most ${MAX_LABELS} labels and icon groups.`);
  }
  const zoneRects = (floor.zones ?? []).reduce((n, z) => n + z.rects.length, 0);
  if (zoneRects > MAX_AREAS) {
    problems.push(`A floor may have at most ${MAX_AREAS} zone rectangles.`);
  }
  for (const rect of [...floor.areas, ...(floor.zones ?? []).flatMap((z) => z.rects)]) {
    if (
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      problems.push('A floor rectangle has no size or an invalid position.');
      break;
    }
  }
  return problems;
}

export type FloorCounts = Record<FloorAreaKind, number>;

/** How many areas of each kind the floor has. */
export function countAreas(floor: HallFloor): FloorCounts {
  const counts = Object.fromEntries(FLOOR_AREA_KINDS.map((kind) => [kind, 0])) as FloorCounts;
  for (const area of floor.areas) {
    counts[area.kind] += 1;
  }
  return counts;
}

/** Square metres of the floor's zones of one kind (zone rectangles never overlap). */
export function zoneArea(floor: HallFloor, kind: FloorZoneKind): number {
  let total = 0;
  for (const zone of floor.zones ?? []) {
    if (zone.kind !== kind) continue;
    for (const r of zone.rects) total += r.width * r.height;
  }
  return Math.round(total * 100) / 100;
}

/** Cell side used to measure floor area. Walls are drawn 0.5 m thick, so this resolves them. */
const CELL = 0.5;

/**
 * The hall's floor area in square metres: its extent less everything outside the outline and
 * the walls, measured on a 0.5 m raster (exact for geometry on that grid, close otherwise).
 */
export function floorArea(floor: HallFloor): number {
  const columns = Math.ceil(floor.width / CELL);
  const rows = Math.ceil(floor.depth / CELL);
  const taken = new Uint8Array(columns * rows);

  for (const area of floor.areas) {
    if (area.kind !== 'outside' && area.kind !== 'wall' && area.kind !== 'void') {
      continue;
    }
    // A cell belongs to the area when its centre lies inside it.
    const c0 = Math.max(0, Math.ceil(area.x / CELL - 0.5));
    const c1 = Math.min(columns - 1, Math.floor((area.x + area.width) / CELL - 0.5 - 1e-9));
    const r0 = Math.max(0, Math.ceil(area.y / CELL - 0.5));
    const r1 = Math.min(rows - 1, Math.floor((area.y + area.height) / CELL - 0.5 - 1e-9));
    for (let r = r0; r <= r1; r++) {
      taken.fill(1, r * columns + c0, r * columns + c1 + 1);
    }
  }

  let free = 0;
  for (let i = 0; i < taken.length; i++) {
    if (taken[i] === 0) {
      free++;
    }
  }
  // Cells on the last row and column may stick out past the extent; trim their excess.
  const full = free * CELL * CELL;
  return Math.round(Math.min(full, floor.width * floor.depth));
}

/**
 * True when two floors describe the same thing (a re-import that changed nothing). Keys are
 * compared sorted: Postgres `jsonb` does not keep the order they were written in.
 */
export function sameFloor(a: HallFloor, b: HallFloor): boolean {
  return stable(a) === stable(b);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
