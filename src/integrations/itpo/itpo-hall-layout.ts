import {
  cleanColor,
  cleanText,
  FLOOR_SCHEMA,
  finite,
  FloorArea,
  FloorAreaKind,
  FloorIconGroup,
  FloorLabel,
  FloorLegendEntry,
  FloorNorth,
  HallFloor,
  mm,
} from '../../venues/floor/hall-floor';
import { csvRecords } from '../csv';

/**
 * ITPO's hall floors, as its SelfCare system stores them: a row of `T_HALL_LAYOUTS` (the base
 * floor of a hall) or of `T_EVENT_HALL_LAYOUT_DATA` (an event-hall's copy of it). Both have the
 * same columns. Rows arrive as a CSV export (JSON columns as text, `NULL` for null) or as JSON
 * (SelfCare's API returns `hallId` and `name` as well).
 *
 * Units, checked against the halls themselves:
 *  - `length` x `breadth` is the hall's extent in metres; `layout_data.nonClickableAreas` are
 *    rectangles in metres, top-left origin, y down; they may reach past the extent.
 *  - `helper_text`, `exit_labels` and `direction` are canvas pixels at 20 px per metre, the
 *    top-left of what is drawn there; often outside the hall (icons beside a wall).
 *  - A rectangle's meaning is its colour, explained by the hall's own `legends`. `#742371` is a
 *    wall and `#ffffff` the outside of an irregular hall; neither is in any legend.
 *  - `visibleInView: false` (the fire curtains) is hidden on the published plan but still
 *    forbids building below it.
 */
export const ITPO_PX_PER_METRE = 20;

export interface ItpoHallRow {
  /** The layout row's own id, when the export has it. */
  layoutId: string | null;
  /** ITPO's `hall_id`: the hall's identity in their system. */
  hallId: string;
  /** Only SelfCare's API gives a name; a database export does not. */
  name: string | null;
  length: unknown;
  breadth: unknown;
  layoutData: unknown;
  legends: unknown;
  helperText: unknown;
  exitLabels: unknown;
  direction: unknown;
  defaultStalls: unknown;
}

export interface ItpoFloorResult {
  floor: HallFloor;
  warnings: string[];
}

/** Reads an export. Throws an Error with a message fit for the person who uploaded it. */
export function readItpoHallRows(content: string, format: 'csv' | 'json'): ItpoHallRow[] {
  const records = format === 'csv' ? csvRecords(content) : jsonRecords(content);
  if (!records.length) {
    throw new Error('The file has no rows.');
  }
  return records.map((record, index) => {
    const hallId = cleanText(pick(record, 'hall_id', 'hallId'), 40);
    if (!hallId || !/^[\w-]+$/.test(hallId)) {
      throw new Error(`Row ${index + 1} has no hall_id. Export T_HALL_LAYOUTS with all columns.`);
    }
    return {
      layoutId: cleanText(record['id'], 40) ?? null,
      hallId,
      name: cleanText(record['name'], 120) ?? null,
      length: record['length'],
      breadth: record['breadth'],
      layoutData: json(pick(record, 'layout_data', 'layoutData')),
      legends: json(record['legends']),
      helperText: json(pick(record, 'helper_text', 'helperText')),
      exitLabels: json(pick(record, 'exit_labels', 'exitLabels')),
      direction: json(record['direction']),
      defaultStalls: json(pick(record, 'default_stalls', 'defaultStalls')),
    };
  });
}

/** Converts one ITPO hall row into our floor. Throws when the row has no usable size. */
export function itpoRowToFloor(row: ItpoHallRow): ItpoFloorResult {
  const warnings: string[] = [];
  const width = finite(row.length);
  const depth = finite(row.breadth);
  if (width === undefined || depth === undefined || width <= 0 || depth <= 0) {
    throw new Error(`Hall ${row.hallId} has no length and breadth.`);
  }

  const legend = readLegend(row.legends);
  const meaning = new Map<string, FloorAreaKind>();
  for (const entry of legend) {
    if (entry.color && entry.kind) {
      meaning.set(entry.color, entry.kind);
    }
  }

  const areas: FloorArea[] = [];
  const unknownColors = new Set<string>();
  let dropped = 0;
  for (const raw of list(objectAt(row.layoutData, 'nonClickableAreas'))) {
    const x = finite(raw['x']);
    const y = finite(raw['y']);
    const w = finite(raw['width']);
    const h = finite(raw['height']);
    if (x === undefined || y === undefined || !w || !h || w <= 0 || h <= 0) {
      dropped++;
      continue;
    }
    const color = cleanColor(raw['fillColor']);
    const label = cleanText(raw['title'], 80);
    const kind = classify(color, label, meaning);
    if (kind === 'marking' && color) {
      unknownColors.add(color);
    }
    areas.push({
      kind,
      x: mm(x),
      y: mm(y),
      width: mm(w),
      height: mm(h),
      ...(label ? { label } : {}),
      ...(color ? { color } : {}),
      ...(raw['visibleInView'] === false ? { hidden: true } : {}),
    });
  }

  if (dropped) {
    warnings.push(`${dropped} area(s) without a usable position or size were left out.`);
  }
  for (const color of unknownColors) {
    warnings.push(
      `The colour ${color} is not explained in this hall's legend; its areas are kept as ` +
        'markings, which do not block stalls.',
    );
  }
  const templates = list(row.defaultStalls).length;
  if (templates) {
    warnings.push(
      `${templates} template stall(s) were not imported: stalls come with the planner.`,
    );
  }

  return {
    floor: {
      schema: FLOOR_SCHEMA,
      width: mm(width),
      depth: mm(depth),
      areas,
      labels: readLabels(row.exitLabels),
      iconGroups: readIconGroups(row.helperText),
      north: readNorth(row.direction),
      legend,
    },
    warnings,
  };
}

// --- meaning of a colour ---------------------------------------------------------------------

/** What ITPO's colours mean when a hall's legend does not say. */
const DEFAULT_MEANING: Record<string, FloorAreaKind> = {
  '#742371': 'wall',
  '#ffffff': 'outside',
  '#fff': 'outside',
  white: 'outside',
  red: 'passage',
  '#8a2be2': 'fire_curtain',
  saddlebrown: 'no_build',
  yellow: 'unavailable',
  '#2e8b57': 'entry',
  gray: 'column',
  blue: 'utility',
};

/** A legend label's meaning, from the words ITPO uses in its legends. */
export function kindFromWords(text: string): FloorAreaKind | undefined {
  const words = text.toLowerCase();
  if (/fire curtain/.test(words)) return 'fire_curtain';
  if (/passage/.test(words)) return 'passage';
  if (/no[ -]?construction|\bnc\b/.test(words)) return 'no_build';
  if (/column|pillar/.test(words)) return 'column';
  if (/electric|panel|hydrant|utility/.test(words)) return 'utility';
  if (/not available/.test(words)) return 'unavailable';
  if (/entry|exit|gate/.test(words)) return 'entry';
  return undefined;
}

function classify(
  color: string | undefined,
  label: string | undefined,
  legend: Map<string, FloorAreaKind>,
): FloorAreaKind {
  // A rectangle's own title is the most specific statement ("Pillar", "Electrical Panel").
  const titled = label ? kindFromWords(label) : undefined;
  if (titled) return titled;
  if (!color) return 'marking';
  // Walls and the outside are never in a legend, and a legend must not redefine them.
  if (color === '#742371') return 'wall';
  if (color === '#ffffff' || color === '#fff' || color === 'white') return 'outside';
  return legend.get(color) ?? DEFAULT_MEANING[color] ?? 'marking';
}

// --- annotations -------------------------------------------------------------------------------

function readLegend(value: unknown): FloorLegendEntry[] {
  const entries: FloorLegendEntry[] = [];
  for (const raw of list(value)) {
    const label = cleanText(raw['label']);
    if (!label) continue;
    const color = cleanColor(raw['colorCode']);
    const code = cleanText(raw['htmlContent'], 40);
    const kind = color ? (kindFromWords(label) ?? DEFAULT_MEANING[color]) : undefined;
    entries.push({
      label,
      ...(color ? { color } : {}),
      ...(kind ? { kind } : {}),
      ...(code ? { code } : {}),
      // Colour rows say `visibleInViewMode`, code rows `visibleInBookMode`; either hides it.
      showInView: raw['visibleInViewMode'] !== false && raw['visibleInBookMode'] !== false,
    });
  }
  return entries;
}

function readLabels(value: unknown): FloorLabel[] {
  const labels: FloorLabel[] = [];
  for (const raw of list(value)) {
    const text = cleanText(raw['text'], 80);
    const x = finite(raw['positionX']);
    const y = finite(raw['positionY']);
    if (text && x !== undefined && y !== undefined) {
      labels.push({ text, x: px(x), y: px(y) });
    }
  }
  return labels;
}

function readIconGroups(value: unknown): FloorIconGroup[] {
  const groups: FloorIconGroup[] = [];
  for (const raw of list(value)) {
    const x = finite(raw['positionX']);
    const y = finite(raw['positionY']);
    const icons = list(raw['image']).flatMap((image) => {
      const kind = iconKind(image['url']);
      const label = cleanText(image['label'], 80) ?? kind;
      return kind && label ? [{ kind, label }] : [];
    });
    if (x !== undefined && y !== undefined && icons.length) {
      groups.push({ x: px(x), y: px(y), icons });
    }
  }
  return groups;
}

/** `assets/images/toilet-male.svg` -> `toilet-male`. Anything else is not an icon name. */
function iconKind(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const name = url
    .split('/')
    .pop()
    ?.replace(/\.svg$/i, '')
    .toLowerCase();
  return name && /^[a-z0-9][a-z0-9-]{0,40}$/.test(name) ? name : undefined;
}

function readNorth(value: unknown): FloorNorth | null {
  const raw = asObject(value);
  if (!raw) return null;
  const x = finite(raw['positionX']);
  const y = finite(raw['positionY']);
  if (x === undefined || y === undefined) return null;
  const image = asObject(raw['image']) ?? {};
  const label = asObject(raw['label']) ?? {};
  return {
    x: px(x),
    y: px(y),
    size: px(finite(image['width']) ?? 100),
    rotation: finite(image['rotation']) ?? 0,
    label: cleanText(label['text'], 4) ?? 'N',
  };
}

// --- reading helpers ---------------------------------------------------------------------------

const px = (value: number) => mm(value / ITPO_PX_PER_METRE);

type Json = Record<string, unknown>;

function jsonRecords(content: string): Json[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  // SelfCare's API wraps rows as `{ header, data: [...] }`; a bare row or a list also works.
  const data = asObject(parsed)?.['data'] ?? parsed;
  return (Array.isArray(data) ? data : [data]).filter((row): row is Json => asObject(row) !== null);
}

function pick(record: Json, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

/** A JSON column: already parsed (JSON export) or text (CSV export, `NULL` for null). */
function json(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  const text = value.trim();
  if (!text || text === 'NULL' || text === 'null') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asObject(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function objectAt(value: unknown, key: string): unknown {
  return asObject(value)?.[key];
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => asObject(item) !== null) : [];
}
