import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { FloorArea, HallZone, Point, traceFloor } from '../src/layouts/placement/placement-rules';

/**
 * Builds the planner geometry of EVERY hall from its SelfCare plan.
 *
 * INPUT (either, or both):
 *   - `T_EVENT_HALL_LAYOUT_DATA.csv`, the database export (one row per hall per event). Per hall
 *     the row with the most `nonClickableAreas` is used, as before. The export has no hall name,
 *     so HALL_NAMES bridges `hall_id` -> name.
 *   - SelfCare hall-layout API responses (`GET .../event-hall-layouts-data/{id}`), saved as
 *     `.json` files: `{ header, data: [row] }`, a bare row, or a list. These carry `name` and are
 *     the plan as SelfCare currently publishes it; for a hall present in both, the JSON wins.
 *
 *   npm run build:hall-shapes -- [T_EVENT_HALL_LAYOUT_DATA.csv] [responses/*.json] [--out <dir>]
 *
 * With no CSV argument the default path (../../../T_EVENT_HALL_LAYOUT_DATA.csv) is used only if
 * no JSON file was given. `--out` writes the results elsewhere instead of scripts/data (dry runs).
 *
 * OUTPUT:
 *   - data/hall-plans.json      every hall: rectangles, zones, outline, labels, icons, north arrow,
 *                               legend — consumed by `npm run seed:hall-plans`.
 *   - data/demo-hall-shapes.json the five demo halls, same content — consumed by seed:demo-halls.
 *   - data/hall-amenities.json  icons only, per hall — consumed by seed:hall-amenities.
 *   - data/demo-layouts.json    the demo layouts, with their hall geometry refreshed and any stall
 *                               standing on a source rectangle or zone dropped (conflict report).
 *
 * CONVERSION (identical to the planner's importer, frontend selfcare-layout.ts):
 *   - rectangles: top-left metres -> centre-origin metres, posX = x + w/2 - W/2,
 *     posZ = y + h/2 - L/2, W = `length`, L = `breadth`. NOTHING is clipped to W x L: walls and
 *     masks legitimately reach past it (Hall 8-9-10 to y 45 on 43 m; the 14GF foyer).
 *   - `#742371` -> wall, `#ffffff` -> outside; a colour the row's legend names as passage /
 *     no-construction / curtain / partition (else red / saddlebrown / #8a2be2) -> a typed zone,
 *     which blocks; any other colour (pillars...) -> a coloured rectangle, drawn, not blocking.
 *   - `visibleInView: false` (the fire curtains) is KEPT, flagged `hidden`: not drawn, still
 *     blocking. It used to be dropped, which freed the area under every curtain.
 *   - outline: traced from the rectangles (traceFloor, the same function the planner and the
 *     server validation use). A hall whose floor is ONE region without holes gets it as
 *     `boundary` and becomes rule-driven, as before; a hall with several regions (a main floor and
 *     a separate foyer, Hall 1GF / 2GF / 14GF) keeps `boundary` null and is drawn and validated
 *     from its rectangles, all regions included. Previously such a hall got no outline at all
 *     and anything past `breadth` was cut off.
 *   - `exit_labels`, `helper_text`, `direction` are canvas pixels at 20 px per metre, same
 *     top-left origin, and give the TOP-LEFT of what is drawn there. Verified on Hall 8-9-10
 *     (HALL 8/9/10 captions at y 860 px = 43 m, the bottom edge) and Hall 1GF (every EE1-n label
 *     against its wall, GG1-1/GG1-2 on their red markers, FOYER-1G on the foyer).
 *   - `helper_text`: EVERY icon (`assets/images/<name>.svg`), not only toilets / stairs / entry.
 *     Each entry is one card of icons in a row; `anchor` is the card's top-left, `slot` the
 *     icon's place, `position` its centre (same card layout as the frontend's plan-annotations.ts).
 *
 * NOTHING IN PRODUCTION IS READ OR WRITTEN. Input is the export / saved responses.
 */

const DEMO_HALLS = [
  { hallId: 49, name: 'Hall 1GF' },
  { hallId: 51, name: 'Hall 2GF' },
  { hallId: 65, name: 'Hall 12' },
  { hallId: 63, name: 'Hall 8-9-10' },
  { hallId: 78, name: 'Convention Center' },
] as const;

/** Canvas pixels per metre of `exit_labels` / `helper_text` / `direction` (see above). */
const PX_PER_METRE = 20;

/** Stored on every hall that gets a boundary. Metres; see LayoutRules in placement-rules.ts. */
const ITPO_RULES = {
  minPassageWidth: { B2B: 3, B2C: 4 },
  peripheralClearance: 1,
  zoneClearance: { FACILITY_ACCESS: 1, PARTITION: 1, SMOKE_CURTAIN: 1 },
  openingAccessDepth: null,
  gridUnit: 1,
  snapStep: 1,
  stallNumberPrefix: 'STALL-',
};

/** Booking status from the colour the dump conversion used (see demo-layouts _provenance). */
const BOOKED_COLOR = '#b91c1c';

// --- source shapes -------------------------------------------------------------------------------

interface SourceArea {
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor?: string;
  strokeColor?: string;
  title?: string;
  visibleInView?: boolean;
}

/** One hall's plan, from a CSV row or an API response: JSON columns may be text or parsed. */
interface SourceRow {
  hallId: number | null;
  name: string | null;
  length: unknown;
  breadth: unknown;
  layout_data: unknown;
  legends: unknown;
  exit_labels: unknown;
  helper_text: unknown;
  direction: unknown;
  origin: string;
}

interface CsvRow {
  id: string;
  hall_id: string;
  layout_data: string;
  length: string;
  breadth: string;
  legends: string;
  exit_labels: string;
  helper_text: string;
  direction: string | undefined;
}

// --- planner shapes (mirror the frontend hall.model.ts / backend hall.entity.ts) ------------------

interface BlockedArea {
  posX: number;
  posZ: number;
  width: number;
  length: number;
  kind: 'outside' | 'wall' | 'zone';
  color: string;
  strokeColor?: string;
  title?: string;
  hidden?: boolean;
}

interface HallMarker {
  text: string;
  position: Point;
}

interface HallAmenity {
  kind: string;
  label: string;
  position: Point;
  anchor: Point;
  slot: number;
}

interface HallCompass {
  position: Point;
  size: number;
  rotation: number;
  label: string;
  labelOffset: Point;
}

interface HallLegend {
  label: string;
  colorCode?: string;
  htmlContent?: string;
  visibleInViewMode?: boolean;
  visibleInBookMode?: boolean;
}

interface HallPlan {
  hallName: string;
  prodHallId: number | null;
  width: number;
  length: number;
  source: {
    from: string;
    areas: { outside: number; wall: number; zone: number; hidden: number };
    regions: number;
  };
  blockedAreas: BlockedArea[];
  boundary: Point[] | null;
  zones: HallZone[];
  openings: never[];
  markers: HallMarker[];
  amenities: HallAmenity[];
  compass: HallCompass | null;
  legends: HallLegend[];
  rules: typeof ITPO_RULES | null;
}

interface DemoLayoutsFile {
  _provenance: string;
  layouts: Array<{
    layoutName: string;
    hall: { name: string; shape: string; width: number; length: number; radius: number };
    stalls: Array<{ name: string; width: number; length: number; posX: number; posZ: number }>;
    source: {
      prodHallId: number;
      seeded: number;
      dropped: unknown[];
      [key: string]: unknown;
    };
  }>;
}

// --- RFC-4180 CSV parsing (quoted fields, doubled quotes, embedded commas) ---

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// --- conversion ------------------------------------------------------------------------------

const round = (v: number): number => Math.round(v * 1e6) / 1e6;
const WALL_COLOR = '#742371';
const OUTSIDE_COLOR = '#ffffff';
const ZONE_BY_COLOR: Record<string, HallZone['kind']> = {
  red: 'PASSAGE',
  saddlebrown: 'NO_CONSTRUCTION',
  '#8a2be2': 'SMOKE_CURTAIN',
};
/** A local icon name only; a remote URL or a path is refused. */
const ICON_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

function parseJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || text === 'NULL') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const color = (v: unknown): string =>
  String(v ?? '')
    .trim()
    .toLowerCase();

/** Legend label -> zone kind. Curtains first: "Fire curtains (No construction zone below)". */
function zoneKindOfLabel(label: string): HallZone['kind'] | null {
  const l = label.toLowerCase();
  if (l.includes('curtain')) return 'SMOKE_CURTAIN';
  if (l.includes('passage')) return 'PASSAGE';
  if (l.includes('no construction') || /\bnc\b/.test(l)) return 'NO_CONSTRUCTION';
  if (l.includes('partition')) return 'PARTITION';
  return null;
}

function iconName(url: unknown): string | null {
  const match = /^(?:\.?\/)?(?:assets\/images\/)?([^/\\?#]+)\.svg$/i.exec(String(url ?? '').trim());
  const name = match?.[1];
  return name && ICON_NAME.test(name) ? name.toLowerCase() : null;
}

/**
 * The icon card layout, in metres. MUST match `cardLayout` in the frontend's
 * src/app/planner/geometry/plan-annotations.ts (sizes measured on the reference plan).
 */
function cardSlots(captions: string[]): Array<{ iconX: number; iconZ: number }> {
  const ICON_SIZE = 1.9;
  const CAPTION_FONT = 0.75;
  const CARD_PADDING = 0.6;
  const SLOT_GAP = 0.8;
  let x = CARD_PADDING;
  return captions.map((caption, i) => {
    const width = Math.max(ICON_SIZE, caption.length * CAPTION_FONT * 0.65);
    if (i > 0) x += SLOT_GAP;
    const slot = { iconX: x + width / 2, iconZ: CARD_PADDING + ICON_SIZE / 2 };
    x += width;
    return slot;
  });
}

export function buildPlan(row: SourceRow, hallName: string): HallPlan | null {
  const data = (parseJson(row.layout_data) ?? {}) as { nonClickableAreas?: SourceArea[] };
  const areas = (Array.isArray(data.nonClickableAreas) ? data.nonClickableAreas : []).filter(
    (a) =>
      a &&
      Number.isFinite(a.x) &&
      Number.isFinite(a.y) &&
      Number(a.width) > 0 &&
      Number(a.height) > 0,
  );

  // W = `length`, L = `breadth`; when NULL, the rectangles' own extent.
  const W = num(row.length) || Math.max(0, ...areas.map((a) => a.x + a.width));
  const L = num(row.breadth) || Math.max(0, ...areas.map((a) => a.y + a.height));
  if (!(W > 0) || !(L > 0)) return null;
  const px = (x: unknown, y: unknown): Point => ({
    x: round(num(x) / PX_PER_METRE - W / 2),
    z: round(num(y) / PX_PER_METRE - L / 2),
  });

  const legendRows = (Array.isArray(parseJson(row.legends)) ? parseJson(row.legends) : []) as Array<
    Record<string, unknown>
  >;
  const legendByColor = new Map<string, string>();
  for (const l of legendRows) {
    if (typeof l?.colorCode === 'string' && typeof l?.label === 'string') {
      legendByColor.set(color(l.colorCode), l.label.trim());
    }
  }

  const blockedAreas: BlockedArea[] = [];
  const zones: HallZone[] = [];
  let hidden = 0;
  for (const a of areas) {
    const fill = color(a.fillColor ?? a.strokeColor);
    const stroke = color(a.strokeColor);
    const isHidden = a.visibleInView === false;
    if (isHidden) hidden++;
    const legend = legendByColor.get(fill);
    const kind = (legend ? zoneKindOfLabel(legend) : null) ?? ZONE_BY_COLOR[fill];

    if (kind) {
      const minX = round(a.x - W / 2);
      const minZ = round(a.y - L / 2);
      const maxX = round(minX + a.width);
      const maxZ = round(minZ + a.height);
      zones.push({
        id: `sc-zone-${zones.length + 1}`,
        kind,
        label: a.title?.trim() || legend || kind,
        polygon: [
          { x: minX, z: minZ },
          { x: maxX, z: minZ },
          { x: maxX, z: maxZ },
          { x: minX, z: maxZ },
        ],
        color: fill,
        ...(isHidden ? { hidden: true } : {}),
      });
      continue;
    }

    blockedAreas.push({
      posX: round(a.x + a.width / 2 - W / 2),
      posZ: round(a.y + a.height / 2 - L / 2),
      width: a.width,
      length: a.height,
      kind: fill === WALL_COLOR ? 'wall' : fill === OUTSIDE_COLOR ? 'outside' : 'zone',
      color: fill || '#000000',
      ...(stroke && stroke !== fill ? { strokeColor: stroke } : {}),
      ...(a.title?.trim() ? { title: a.title.trim() } : {}),
      ...(isHidden ? { hidden: true } : {}),
    });
  }

  const floor = traceFloor(blockedAreas as FloorArea[], W, L);
  const single = floor.length === 1 && floor[0].holes.length === 0;
  const boundary = single ? floor[0].outer : null;

  const markers: HallMarker[] = [];
  for (const l of (parseJson(row.exit_labels) ?? []) as Array<Record<string, unknown>>) {
    const text = String(l?.text ?? '').trim();
    if (!text || !Number.isFinite(l.positionX) || !Number.isFinite(l.positionY)) continue;
    markers.push({ text, position: px(l.positionX, l.positionY) });
  }

  const amenities: HallAmenity[] = [];
  for (const h of (parseJson(row.helper_text) ?? []) as Array<Record<string, unknown>>) {
    if (!Number.isFinite(h?.positionX) || !Number.isFinite(h?.positionY)) continue;
    const icons = (Array.isArray(h.image) ? h.image : [])
      .map((i: Record<string, unknown>) => ({
        kind: iconName(i?.url),
        label: String(i?.label ?? '').trim(),
      }))
      .filter((i): i is { kind: string; label: string } => !!i.kind);
    if (!icons.length) continue;
    const anchor = px(h.positionX, h.positionY);
    const slots = cardSlots(icons.map((i) => (i.label || i.kind).toUpperCase()));
    icons.forEach((icon, slot) =>
      amenities.push({
        kind: icon.kind,
        label: icon.label || icon.kind,
        position: {
          x: round(anchor.x + slots[slot].iconX),
          z: round(anchor.z + slots[slot].iconZ),
        },
        anchor,
        slot,
      }),
    );
  }

  const legends: HallLegend[] = legendRows
    .filter((l) => typeof l?.label === 'string' && l.label.trim())
    .map((l) => ({
      label: String(l.label).trim(),
      ...(typeof l.colorCode === 'string' ? { colorCode: color(l.colorCode) } : {}),
      ...(typeof l.htmlContent === 'string' ? { htmlContent: l.htmlContent } : {}),
      ...(typeof l.visibleInViewMode === 'boolean'
        ? { visibleInViewMode: l.visibleInViewMode }
        : {}),
      ...(typeof l.visibleInBookMode === 'boolean'
        ? { visibleInBookMode: l.visibleInBookMode }
        : {}),
    }));

  const count = (k: BlockedArea['kind']): number => blockedAreas.filter((a) => a.kind === k).length;
  return {
    hallName,
    prodHallId: row.hallId,
    width: W,
    length: L,
    source: {
      from: row.origin,
      areas: {
        outside: count('outside'),
        wall: count('wall'),
        zone: count('zone') + zones.length,
        hidden,
      },
      regions: floor.length,
    },
    blockedAreas,
    boundary,
    zones,
    openings: [],
    markers,
    amenities,
    compass: compassOf(parseJson(row.direction) as Record<string, any> | null, px),
    legends,
    rules: boundary ? ITPO_RULES : null,
  };
}

/** `direction`: box top-left, rose drawn at image.positionX/Y inside it, letter at label.positionX/Y. */
function compassOf(
  d: Record<string, any> | null,
  px: (x: unknown, y: unknown) => Point,
): HallCompass | null {
  if (!d || !Number.isFinite(d.positionX) || !Number.isFinite(d.positionY)) return null;
  const box = px(d.positionX, d.positionY);
  const size = num(d.image?.width) / PX_PER_METRE || 5;
  const position = {
    x: round(box.x + num(d.image?.positionX) / PX_PER_METRE + size / 2),
    z: round(box.z + num(d.image?.positionY) / PX_PER_METRE + size / 2),
  };
  return {
    position,
    size,
    rotation: num(d.image?.rotation),
    label: String(d.label?.text ?? 'N').trim() || 'N',
    labelOffset: {
      x: round(box.x + num(d.label?.positionX) / PX_PER_METRE - position.x),
      z: round(box.z + num(d.label?.positionY) / PX_PER_METRE - position.z),
    },
  };
}

/**
 * Same axis-aligned math and 1e-8 epsilon as the planner's placement check: outside masks, walls
 * and every typed zone (passages, no-construction, fire curtains — hidden ones too) block. Other
 * coloured rectangles (pillars) do not: pavilions are built around pillars.
 */
function overlapsBlocked(
  stall: { posX: number; posZ: number; width: number; length: number },
  areas: BlockedArea[],
): BlockedArea | null {
  for (const area of areas) {
    if (area.kind === 'zone' && !area.color.startsWith('zone:')) continue;
    if (
      Math.abs(stall.posX - area.posX) < (stall.width + area.width) / 2 - 1e-8 &&
      Math.abs(stall.posZ - area.posZ) < (stall.length + area.length) / 2 - 1e-8
    ) {
      return area;
    }
  }
  return null;
}

/**
 * Every hall in the CSV, by the name it carries in the `hall` table.
 *
 * The CSV has no hall name, only `hall_id`, so this map is the bridge. It is not guesswork:
 *  - 10 ids are anchored by DEMO_HALLS' own source comments and by the event API payload
 *    (49 Hall 1GF, 51 Hall 2GF, 61 Hall 14GF, 62 Hall 14FF, 63 Hall 8-9-10, 64 Hall 11,
 *    65 Hall 12, 67 Hall 12A, 75 F&B Vending Point, 78 Convention Center).
 *  - Those anchors show ground-floor ids always precede their first-floor twin (49/50, 51/52,
 *    61/62), which fixes the remaining GF/FF pairs.
 *  - Hall 4GF is 66 x 90, unique in the whole export, and lands exactly where that ordering
 *    predicts (id 55) — an independent check on the pattern.
 *  - Finally, every one of the 24 mappings was verified against the hall's width/length in the
 *    database. All match.
 *
 * Ids 81, 82, 84 and 85 are omitted: their names could not be established from the export. The
 * builder reports them as skipped rather than guessing; a saved API response carries the name.
 */
const HALL_NAMES: Readonly<Record<number, string>> = {
  49: 'Hall 1GF',
  50: 'Hall 1FF',
  51: 'Hall 2GF',
  52: 'Hall 2FF',
  53: 'Hall 3GF',
  54: 'Hall 3FF',
  55: 'Hall 4GF',
  56: 'Hall 4FF',
  57: 'Hall 5GF',
  58: 'Hall 5FF',
  60: 'Hall 6',
  61: 'Hall 14GF',
  62: 'Hall 14FF',
  63: 'Hall 8-9-10',
  64: 'Hall 11',
  65: 'Hall 12',
  67: 'Hall 12A',
  74: 'PNG Nozzle',
  75: 'F&B Vending Point',
  76: 'F&B Outlet',
  77: 'Hall 1A & Hall 1B',
  78: 'Convention Center',
  79: 'Hall 2 & 3',
  80: 'HN1 to HN4',
};

// --- input ------------------------------------------------------------------------------------

function csvRows(path: string): SourceRow[] {
  const rows = parseCsv(readFileSync(path, 'utf-8'));
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string, required = true): number => {
    const idx = header.indexOf(name);
    if (idx === -1 && required) throw new Error(`CSV column not found: ${name}`);
    return idx;
  };
  const c = {
    id: col('id'),
    hall_id: col('hall_id'),
    layout_data: col('layout_data'),
    length: col('length'),
    breadth: col('breadth'),
    legends: col('legends'),
    exit_labels: col('exit_labels'),
    helper_text: col('helper_text'),
    direction: col('direction', false),
  };
  const data: CsvRow[] = rows.slice(1).map((r) => ({
    id: r[c.id],
    hall_id: r[c.hall_id],
    layout_data: r[c.layout_data],
    length: r[c.length],
    breadth: r[c.breadth],
    legends: r[c.legends],
    exit_labels: r[c.exit_labels],
    helper_text: r[c.helper_text],
    direction: c.direction === -1 ? undefined : r[c.direction],
  }));

  // Per hall, the row with the most nonClickableAreas (unchanged rule).
  const best = new Map<number, { row: CsvRow; n: number }>();
  for (const row of data) {
    const hallId = Number(row.hall_id);
    const parsed = parseJson(row.layout_data) as { nonClickableAreas?: unknown[] } | null;
    if (!parsed) continue;
    const n = Array.isArray(parsed.nonClickableAreas) ? parsed.nonClickableAreas.length : 0;
    const seen = best.get(hallId);
    if (!seen || n > seen.n) best.set(hallId, { row, n });
  }

  return [...best.entries()].map(([hallId, { row }]) => ({
    hallId,
    name: HALL_NAMES[hallId] ?? null,
    length: row.length,
    breadth: row.breadth,
    layout_data: row.layout_data,
    legends: row.legends,
    exit_labels: row.exit_labels,
    helper_text: row.helper_text,
    direction: row.direction,
    origin: `T_EVENT_HALL_LAYOUT_DATA.csv row ${row.id}`,
  }));
}

export function jsonRows(path: string): SourceRow[] {
  const payload = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  const bodies = Array.isArray(payload) ? payload : [payload];
  return bodies
    .flatMap((b) => {
      const body = b && typeof b === 'object' && 'data' in b ? (b as { data: unknown }).data : b;
      return Array.isArray(body) ? body : body ? [body] : [];
    })
    .map((r: Record<string, unknown>) => {
      const hallId = Number(r.hallId ?? r.hall_id);
      return {
        hallId: Number.isFinite(hallId) ? hallId : null,
        name:
          typeof r.name === 'string' && r.name.trim()
            ? r.name.trim()
            : Number.isFinite(hallId)
              ? (HALL_NAMES[hallId] ?? null)
              : null,
        length: r.length,
        breadth: r.breadth,
        layout_data: r.layout_data,
        legends: r.legends,
        exit_labels: r.exit_labels,
        helper_text: r.helper_text,
        direction: r.direction,
        origin: `API response ${path.split('/').pop()}`,
      };
    });
}

// --- main ----------------------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const dataDir = join(__dirname, 'data');
  const outDir = outIdx >= 0 ? resolve(args[outIdx + 1]) : dataDir;
  const annotationsOnly = args.includes('--annotations-only');
  const inputs = args.filter(
    (arg, i) => arg !== '--annotations-only' && (outIdx < 0 || (i !== outIdx && i !== outIdx + 1)),
  );
  const jsonInputs = inputs.filter((a) => a.toLowerCase().endsWith('.json')).map((a) => resolve(a));
  const csvInputs = inputs.filter((a) => a.toLowerCase().endsWith('.csv')).map((a) => resolve(a));
  if (!csvInputs.length && !jsonInputs.length) {
    csvInputs.push(
      resolve(join(__dirname, '..', '..', '..', '..', 'T_EVENT_HALL_LAYOUT_DATA.csv')),
    );
  }
  mkdirSync(outDir, { recursive: true });

  // JSON (the live plan) overrides the export for a hall present in both.
  const byName = new Map<string, SourceRow>();
  for (const row of [...csvInputs.flatMap(csvRows), ...jsonInputs.flatMap(jsonRows)]) {
    if (!row.name) {
      console.log(`WARN  hall_id ${row.hallId} (${row.origin}) — no hall name known, skipped`);
      continue;
    }
    byName.set(row.name, row);
  }

  const plans: Record<string, HallPlan> = {};
  for (const [name, row] of byName) {
    const plan = buildPlan(row, name);
    if (!plan) {
      console.log(`WARN  ${name} (${row.origin}) — no size and no rectangles, skipped`);
      continue;
    }
    plans[name] = plan;
    const a = plan.source.areas;
    console.log(
      `plan  ${name.padEnd(20)} ${plan.width}x${plan.length}  ` +
        `outside ${a.outside}, wall ${a.wall}, zone ${a.zone} (hidden ${a.hidden}), ` +
        `floor regions ${plan.source.regions}${plan.boundary ? ` -> boundary ${plan.boundary.length} v` : ''}, ` +
        `labels ${plan.markers.length}, icons ${plan.amenities.length}, compass ${plan.compass ? 'yes' : 'no'}, ` +
        `legend ${plan.legends.length} — ${row.origin}`,
    );
  }
  for (const demo of DEMO_HALLS) {
    if (!plans[demo.name])
      console.log(`WARN  ${demo.name} (hall_id ${demo.hallId}) — no plan in the input`);
  }

  const provenance =
    'Generated by scripts/build-demo-hall-shapes.ts from the SelfCare plan (T_EVENT_HALL_LAYOUT_DATA.csv ' +
    'and/or saved hall-layout API responses). Rectangles converted to centre-origin metres, never clipped ' +
    'to length x breadth; labels, icons and north arrow at 20 px/m, top-left anchored. No production ' +
    'system was read or written.';

  // Keep both seed paths on the same annotations, including after a full regeneration.
  {
    const annotations = Object.fromEntries(
      Object.entries(plans).map(([name, plan]) => [
        name,
        {
          prodHallId: plan.prodHallId,
          width: plan.width,
          length: plan.length,
          amenities: plan.amenities,
          markers: plan.markers,
          compass: plan.compass,
          legends: plan.legends,
        },
      ]),
    );
    writeFileSync(
      join(outDir, 'hall-annotations.json'),
      `${JSON.stringify({ _provenance: provenance, halls: annotations }, null, 2)}\n`,
    );
  }
  // Repair old imports without rewriting their geometry or saved demo-layout fixtures.
  if (annotationsOnly) {
    writeFileSync(
      join(outDir, 'hall-amenities.json'),
      `${JSON.stringify(
        {
          _provenance: provenance,
          halls: Object.fromEntries(
            Object.entries(plans).map(([name, plan]) => [name, plan.amenities]),
          ),
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `wrote hall-annotations.json and hall-amenities.json — ${Object.keys(plans).length} halls; geometry and layouts untouched`,
    );
    return;
  }

  writeFileSync(
    join(outDir, 'hall-plans.json'),
    `${JSON.stringify({ _provenance: provenance, halls: plans }, null, 2)}\n`,
  );
  console.log(`wrote hall-plans.json — ${Object.keys(plans).length} halls`);

  const demo = Object.fromEntries(
    DEMO_HALLS.filter((d) => plans[d.name]).map((d) => [d.name, plans[d.name]]),
  );
  writeFileSync(
    join(outDir, 'demo-hall-shapes.json'),
    `${JSON.stringify({ _provenance: provenance, halls: demo }, null, 2)}\n`,
  );

  const icons = Object.fromEntries(
    Object.entries(plans)
      .filter(([, p]) => p.amenities.length)
      .map(([n, p]) => [n, p.amenities]),
  );
  writeFileSync(
    join(outDir, 'hall-amenities.json'),
    `${JSON.stringify({ _provenance: provenance, halls: icons }, null, 2)}\n`,
  );
  console.log(`wrote hall-amenities.json — ${Object.keys(icons).length} halls`);

  // --- attach to demo-layouts.json + conflict report ---------------------------------------------
  const layoutsFile = JSON.parse(
    readFileSync(join(dataDir, 'demo-layouts.json'), 'utf-8'),
  ) as DemoLayoutsFile;
  let totalDropped = 0;
  for (const layout of layoutsFile.layouts) {
    const plan = Object.values(plans).find((p) => p.prodHallId === layout.source.prodHallId);
    if (!plan) {
      console.log(
        `WARN  ${layout.layoutName} — no plan for prodHallId ${layout.source.prodHallId}, left as is`,
      );
      continue;
    }
    Object.assign(layout.hall, {
      blockedAreas: plan.blockedAreas,
      boundary: plan.boundary,
      zones: plan.zones,
      openings: plan.openings,
      markers: plan.markers,
      amenities: plan.amenities,
      compass: plan.compass,
      legends: plan.legends,
      rules: plan.rules,
    });
    layout.source['blockedAreasFrom'] = plan.source.from;

    const zoneAreas: BlockedArea[] = plan.zones.map((z) => {
      const xs = z.polygon.map((p) => p.x);
      const zs = z.polygon.map((p) => p.z);
      const [minX, maxX, minZ, maxZ] = [
        Math.min(...xs),
        Math.max(...xs),
        Math.min(...zs),
        Math.max(...zs),
      ];
      return {
        posX: (minX + maxX) / 2,
        posZ: (minZ + maxZ) / 2,
        width: maxX - minX,
        length: maxZ - minZ,
        kind: 'zone',
        // Marks a typed zone for overlapsBlocked(); plain coloured rectangles do not block.
        color: `zone:${z.kind}`,
      };
    });
    const kept: typeof layout.stalls = [];
    for (const stall of layout.stalls) {
      const hit = overlapsBlocked(stall, [...plan.blockedAreas, ...zoneAreas]);
      if (hit) {
        layout.source.dropped.push({
          name: stall.name,
          posX: stall.posX,
          posZ: stall.posZ,
          reason: `overlaps a non-clickable area (${hit.kind} ${hit.color} at ${hit.posX},${hit.posZ})`,
        });
        totalDropped++;
        console.log(
          `drop  ${layout.layoutName} stall "${stall.name}" — overlaps ${hit.kind} ${hit.color}`,
        );
      } else {
        (stall as { status?: string }).status =
          (stall as { color?: string }).color === BOOKED_COLOR ? 'BOOKED' : 'AVAILABLE';
        kept.push(stall);
      }
    }
    layout.stalls = kept;
    layout.source.seeded = kept.length;
  }
  writeFileSync(join(outDir, 'demo-layouts.json'), `${JSON.stringify(layoutsFile, null, 2)}\n`);
  console.log(`wrote demo-layouts.json — ${totalDropped} conflicting stall(s) dropped`);
}

if (require.main === module) main();
