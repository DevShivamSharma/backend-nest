import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Generates `data/demo-hall-shapes.json` (real irregular-hall geometry) from
 * `T_EVENT_HALL_LAYOUT_DATA.csv`, and rewrites `data/demo-layouts.json` so each
 * layout's hall carries the same `blockedAreas`.
 *
 * For each of the five demo halls the CSV row with the most `nonClickableAreas`
 * wins. Every area is converted from top-left origin to the planner's
 * centre-origin system:
 *
 *   posX = x + w/2 - W/2      posZ = y + h/2 - L/2
 *
 * with W = the CSV row's `length`, L = its `breadth` (verified: max X extent of
 * the areas matches `length`, max Y extent matches `breadth`). Colour mapping:
 * `#ffffff` -> 'outside', `#742371` -> 'wall', anything else -> 'zone'.
 *
 * RULE-DRIVEN GEOMETRY (added for the layout editor):
 *   - `boundary`: the hall outline as ONE polygon — the bounding rectangle minus every
 *     'outside' and 'wall' rectangle, traced into a ring (inner face of the walls). Only set when
 *     the result is a single ring without holes; otherwise the hall keeps the rectangle masks.
 *   - `zones`: 'zone' rectangles typed from the row's own `legends` (colour -> label):
 *     "Compulsory passage…" -> PASSAGE, "No Construction…" -> NO_CONSTRUCTION,
 *     "Fire/Smoke curtain…" -> SMOKE_CURTAIN, "partition" -> PARTITION. Untyped colours stay
 *     visual-only blockedAreas.
 *   - `markers`: the row's `exit_labels` (gate names, foyers), px / 20 -> metres, centre origin.
 *   - `openings`: EMPTY. The export has gate labels as single points only — no door width and no
 *     emergency flag — so no access zone is invented. Supply them to populate this.
 *   - `rules`: ITPO defaults (1 unit = 1 m, verified from the "12sqm" labels).
 *
 * CONFLICT REPORT (mandatory before seeding): every stall already in
 * demo-layouts.json is checked against the 'outside' + 'wall' areas with the
 * same overlap math and 1e-8 epsilon as the planner's overlapsBlockedArea().
 * A conflicting stall is DROPPED from the layout json and recorded in its
 * source.dropped list — the validation is never weakened instead.
 *
 * NOTHING IN PRODUCTION IS READ OR WRITTEN. Input is the CSV export file.
 *
 * Run with:  npm run build:hall-shapes [path-to-csv]
 * Default CSV path: ../../../T_EVENT_HALL_LAYOUT_DATA.csv (the Downloads folder
 * the CSV was exported to).
 */

const DEMO_HALLS = [
  { hallId: 49, name: 'Hall 1GF' },
  { hallId: 51, name: 'Hall 2GF' },
  { hallId: 65, name: 'Hall 12' },
  { hallId: 63, name: 'Hall 8-9-10' },
  { hallId: 78, name: 'Convention Center' },
] as const;

interface CsvArea {
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor?: string;
  title?: string;
}

interface CsvRow {
  id: string;
  hall_id: string;
  layout_data: string;
  length: string;
  breadth: string;
  legends: string;
  exit_labels: string;
}

interface Point {
  x: number;
  z: number;
}

interface HallZone {
  id: string;
  kind: 'PASSAGE' | 'NO_CONSTRUCTION' | 'SMOKE_CURTAIN' | 'PARTITION';
  label: string;
  polygon: Point[];
  color: string;
}

interface HallMarker {
  text: string;
  position: Point;
}

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

/** T_STALLS / exit_labels pixel scale, verified against the "12sqm" area labels. */
const PX_PER_UNIT = 20;

/** Booking status from the colour the dump conversion used (see demo-layouts _provenance). */
const BOOKED_COLOR = '#b91c1c';

interface BlockedArea {
  posX: number;
  posZ: number;
  width: number;
  length: number;
  kind: 'outside' | 'wall' | 'zone';
  color: string;
  title?: string;
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

// --- conversion ----------------------------------------------------------------

const round = (v: number): number => Math.round(v * 1e6) / 1e6;

function toBlockedArea(area: CsvArea, hallW: number, hallL: number): BlockedArea {
  const color = String(area.fillColor ?? '').trim() || '#000000';
  const lower = color.toLowerCase();
  const kind = lower === '#ffffff' ? 'outside' : lower === '#742371' ? 'wall' : 'zone';

  const out: BlockedArea = {
    posX: round(area.x + area.width / 2 - hallW / 2),
    posZ: round(area.y + area.height / 2 - hallL / 2),
    width: area.width,
    length: area.height,
    kind,
    color,
  };
  if (typeof area.title === 'string' && area.title.trim() !== '') out.title = area.title;
  return out;
}

/** Same axis-aligned math and 1e-8 epsilon as the planner's overlapsBlockedArea(). */
function overlapsBlocked(
  stall: { posX: number; posZ: number; width: number; length: number },
  areas: BlockedArea[],
): BlockedArea | null {
  for (const area of areas) {
    if (area.kind === 'zone') continue;
    if (
      Math.abs(stall.posX - area.posX) < (stall.width + area.width) / 2 - 1e-8 &&
      Math.abs(stall.posZ - area.posZ) < (stall.length + area.length) / 2 - 1e-8
    ) {
      return area;
    }
  }
  return null;
}

// --- outline tracing ---------------------------------------------------------------

/**
 * The hall floor as polygon rings: the W x L bounding rectangle minus every 'outside' and
 * 'wall' rectangle. Exact for axis-aligned input:
 *   1. coordinate compression — every distinct rectangle edge becomes a grid line;
 *   2. each compressed cell is floor or not (its centre tested against the rectangles);
 *   3. every floor-cell edge that borders a non-floor cell is a boundary edge, directed so the
 *      floor is on one fixed side; the edges are stitched into closed rings;
 *   4. collinear vertices are dropped.
 * Rings come back largest first, in centre-origin metres.
 */
function traceOutline(areas: BlockedArea[], hallW: number, hallL: number): Point[][] {
  const x0 = -hallW / 2;
  const x1 = hallW / 2;
  const z0 = -hallL / 2;
  const z1 = hallL / 2;

  const solid = areas
    .filter((a) => a.kind === 'outside' || a.kind === 'wall')
    .map((a) => ({
      minX: a.posX - a.width / 2,
      maxX: a.posX + a.width / 2,
      minZ: a.posZ - a.length / 2,
      maxZ: a.posZ + a.length / 2,
    }));

  const cuts = (lo: number, hi: number, values: number[]): number[] =>
    [...new Set([lo, hi, ...values.filter((v) => v > lo && v < hi)])].sort((a, b) => a - b);
  const xs = cuts(x0, x1, solid.flatMap((r) => [r.minX, r.maxX]));
  const zs = cuts(z0, z1, solid.flatMap((r) => [r.minZ, r.maxZ]));
  const nx = xs.length - 1;
  const nz = zs.length - 1;

  const floor: boolean[][] = [];
  for (let i = 0; i < nx; i++) {
    floor.push([]);
    const cx = (xs[i] + xs[i + 1]) / 2;
    for (let j = 0; j < nz; j++) {
      const cz = (zs[j] + zs[j + 1]) / 2;
      floor[i].push(!solid.some((r) => cx > r.minX && cx < r.maxX && cz > r.minZ && cz < r.maxZ));
    }
  }
  const isFloor = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < nx && j < nz && floor[i][j];

  const key = (x: number, z: number): string => `${x},${z}`;
  const next = new Map<string, Point[]>();
  const add = (a: Point, b: Point): void => {
    const k = key(a.x, a.z);
    next.set(k, [...(next.get(k) ?? []), b]);
  };

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      if (!floor[i][j]) continue;
      const [a, c, b, e] = [xs[i], xs[i + 1], zs[j], zs[j + 1]];
      if (!isFloor(i - 1, j)) add({ x: a, z: e }, { x: a, z: b });
      if (!isFloor(i + 1, j)) add({ x: c, z: b }, { x: c, z: e });
      if (!isFloor(i, j - 1)) add({ x: a, z: b }, { x: c, z: b });
      if (!isFloor(i, j + 1)) add({ x: c, z: e }, { x: a, z: e });
    }
  }

  const rings: Point[][] = [];
  while (next.size > 0) {
    const [startKey, firstTargets] = next.entries().next().value as [string, Point[]];
    const [sx, sz] = startKey.split(',').map(Number);
    const ring: Point[] = [{ x: sx, z: sz }];
    let currentKey = startKey;
    let targets = firstTargets;

    for (;;) {
      const target = targets.pop() as Point;
      if (targets.length === 0) next.delete(currentKey);
      if (target.x === sx && target.z === sz) break;
      ring.push(target);
      currentKey = key(target.x, target.z);
      const more = next.get(currentKey);
      if (!more) break;
      targets = more;
    }

    const simplified = ring.filter((q, k) => {
      const p = ring[(k - 1 + ring.length) % ring.length];
      const r = ring[(k + 1) % ring.length];
      return Math.abs((q.x - p.x) * (r.z - q.z) - (q.z - p.z) * (r.x - q.x)) > 1e-9;
    });
    if (simplified.length >= 3) {
      rings.push(simplified.map((p) => ({ x: round(p.x), z: round(p.z) })));
    }
  }

  const area = (ring: Point[]): number =>
    Math.abs(
      ring.reduce((sum, p, k) => {
        const q = ring[(k + 1) % ring.length];
        return sum + p.x * q.z - q.x * p.z;
      }, 0),
    ) / 2;

  return rings.sort((a, b) => area(b) - area(a));
}

function parseJson(text: string | undefined): unknown {
  if (!text || text === 'NULL') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Zone kind from the legend label the source layout shows for that colour. */
function zoneKindOf(label: string): HallZone['kind'] | null {
  const l = label.toLowerCase();
  if (l.includes('passage')) return 'PASSAGE';
  if (l.includes('no construction')) return 'NO_CONSTRUCTION';
  if (l.includes('curtain')) return 'SMOKE_CURTAIN';
  if (l.includes('partition')) return 'PARTITION';
  return null;
}

function typedZones(areas: BlockedArea[], legends: unknown): HallZone[] {
  const byColor = new Map<string, string>();
  for (const legend of Array.isArray(legends) ? legends : []) {
    const entry = legend as { colorCode?: unknown; label?: unknown };
    if (typeof entry.colorCode === 'string' && typeof entry.label === 'string') {
      byColor.set(entry.colorCode.trim().toLowerCase(), entry.label.trim());
    }
  }

  const zones: HallZone[] = [];
  for (const area of areas) {
    if (area.kind !== 'zone') continue;
    const label = byColor.get(area.color.trim().toLowerCase());
    const kind = label ? zoneKindOf(label) : null;
    if (!label || !kind) continue;

    const minX = round(area.posX - area.width / 2);
    const maxX = round(area.posX + area.width / 2);
    const minZ = round(area.posZ - area.length / 2);
    const maxZ = round(area.posZ + area.length / 2);
    zones.push({
      id: `zone-${zones.length + 1}`,
      kind,
      label,
      color: area.color,
      polygon: [
        { x: minX, z: minZ },
        { x: maxX, z: minZ },
        { x: maxX, z: maxZ },
        { x: minX, z: maxZ },
      ],
    });
  }
  return zones;
}

function exitMarkers(labels: unknown, hallW: number, hallL: number): HallMarker[] {
  const markers: HallMarker[] = [];
  for (const label of Array.isArray(labels) ? labels : []) {
    const entry = label as { text?: unknown; positionX?: unknown; positionY?: unknown };
    if (
      typeof entry.text !== 'string' ||
      typeof entry.positionX !== 'number' ||
      typeof entry.positionY !== 'number'
    ) {
      continue;
    }
    markers.push({
      text: entry.text,
      position: {
        x: round(entry.positionX / PX_PER_UNIT - hallW / 2),
        z: round(entry.positionY / PX_PER_UNIT - hallL / 2),
      },
    });
  }
  return markers;
}

// --- main ----------------------------------------------------------------------

function main(): void {
  const csvPath = resolve(
    process.argv[2] ?? join(__dirname, '..', '..', '..', '..', 'T_EVENT_HALL_LAYOUT_DATA.csv'),
  );
  const dataDir = join(__dirname, 'data');

  const rows = parseCsv(readFileSync(csvPath, 'utf-8'));
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string): number => {
    const idx = header.indexOf(name);
    if (idx === -1) throw new Error(`CSV column not found: ${name}`);
    return idx;
  };
  const cId = col('id');
  const cHallId = col('hall_id');
  const cLayoutData = col('layout_data');
  const cLength = col('length');
  const cBreadth = col('breadth');
  const cLegends = col('legends');
  const cExitLabels = col('exit_labels');

  const dataRows: CsvRow[] = rows.slice(1).map((r) => ({
    id: r[cId],
    hall_id: r[cHallId],
    layout_data: r[cLayoutData],
    length: r[cLength],
    breadth: r[cBreadth],
    legends: r[cLegends],
    exit_labels: r[cExitLabels],
  }));

  const shapes: Record<
    string,
    {
      hallName: string;
      prodHallId: number;
      source: { csvRowId: number; areas: { outside: number; wall: number; zone: number } };
      blockedAreas: BlockedArea[];
      boundary: Point[] | null;
      zones: HallZone[];
      openings: never[];
      markers: HallMarker[];
      rules: typeof ITPO_RULES | null;
    }
  > = {};

  for (const demo of DEMO_HALLS) {
    // Pick the row for this hall with the most nonClickableAreas.
    let best: { row: CsvRow; areas: CsvArea[] } | null = null;
    for (const row of dataRows) {
      if (Number(row.hall_id) !== demo.hallId || !row.layout_data) continue;
      let areas: CsvArea[] = [];
      try {
        const parsed = JSON.parse(row.layout_data) as { nonClickableAreas?: CsvArea[] };
        areas = Array.isArray(parsed.nonClickableAreas) ? parsed.nonClickableAreas : [];
      } catch {
        continue;
      }
      if (!best || areas.length > best.areas.length) best = { row, areas };
    }

    if (!best || best.areas.length === 0) {
      console.log(`WARN  ${demo.name} (hall_id ${demo.hallId}) — no nonClickableAreas row found`);
      shapes[demo.name] = {
        hallName: demo.name,
        prodHallId: demo.hallId,
        source: { csvRowId: 0, areas: { outside: 0, wall: 0, zone: 0 } },
        blockedAreas: [],
        boundary: null,
        zones: [],
        openings: [],
        markers: [],
        rules: null,
      };
      continue;
    }

    // W = CSV length, L = CSV breadth; fall back to the areas' own extent when NULL.
    const maxX = Math.max(...best.areas.map((a) => a.x + a.width));
    const maxY = Math.max(...best.areas.map((a) => a.y + a.height));
    const hallW = Number(best.row.length) || maxX;
    const hallL = Number(best.row.breadth) || maxY;

    const blockedAreas = best.areas.map((a) => toBlockedArea(a, hallW, hallL));
    const count = (k: BlockedArea['kind']): number =>
      blockedAreas.filter((a) => a.kind === k).length;

    const rings = traceOutline(blockedAreas, hallW, hallL);
    const boundary = rings.length === 1 ? rings[0] : null;
    const zones = typedZones(blockedAreas, parseJson(best.row.legends));
    const markers = exitMarkers(parseJson(best.row.exit_labels), hallW, hallL);

    shapes[demo.name] = {
      hallName: demo.name,
      prodHallId: demo.hallId,
      source: {
        csvRowId: Number(best.row.id),
        areas: { outside: count('outside'), wall: count('wall'), zone: count('zone') },
      },
      blockedAreas,
      boundary,
      zones,
      openings: [],
      markers,
      rules: boundary ? ITPO_RULES : null,
    };

    console.log(
      `      ${demo.name} geometry: ${boundary ? `boundary ${boundary.length} vertices` : `no single boundary (${rings.length} rings)`}, ` +
        `zones: ${zones.length}, markers: ${markers.length}`,
    );

    console.log(
      `shape ${demo.name} (hall_id ${demo.hallId}) — csv row ${best.row.id}: ` +
        `${blockedAreas.length} areas ` +
        `(outside=${count('outside')}, wall=${count('wall')}, zone=${count('zone')}), ` +
        `hall ${hallW}x${hallL}`,
    );
  }

  writeFileSync(
    join(dataDir, 'demo-hall-shapes.json'),
    JSON.stringify(
      {
        _provenance:
          'Generated by scripts/build-demo-hall-shapes.ts from T_EVENT_HALL_LAYOUT_DATA.csv. ' +
          'Per hall, the CSV row with the most nonClickableAreas was converted to centre-origin ' +
          'coordinates (posX = x + w/2 - W/2, posZ = y + h/2 - L/2; W = csv length, L = csv breadth). ' +
          'Colour mapping: #ffffff -> outside, #742371 -> wall, else zone. No production system was read or written.',
        halls: shapes,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('wrote data/demo-hall-shapes.json');

  // --- attach to demo-layouts.json + conflict report ---------------------------

  const layoutsPath = join(dataDir, 'demo-layouts.json');
  const layoutsFile = JSON.parse(readFileSync(layoutsPath, 'utf-8')) as DemoLayoutsFile;

  let totalDropped = 0;
  for (const layout of layoutsFile.layouts) {
    const shape = Object.values(shapes).find((s) => s.prodHallId === layout.source.prodHallId);
    if (!shape) {
      console.log(`WARN  ${layout.layoutName} — no shape for prodHallId ${layout.source.prodHallId}`);
      continue;
    }

    Object.assign(layout.hall, {
      blockedAreas: shape.blockedAreas,
      boundary: shape.boundary,
      zones: shape.zones,
      openings: shape.openings,
      markers: shape.markers,
      rules: shape.rules,
    });
    layout.source['blockedAreasFrom'] = `T_EVENT_HALL_LAYOUT_DATA.csv row ${shape.source.csvRowId}`;

    const kept: typeof layout.stalls = [];
    for (const stall of layout.stalls) {
      const hit = overlapsBlocked(stall, shape.blockedAreas);
      if (hit) {
        layout.source.dropped.push({
          name: stall.name,
          posX: stall.posX,
          posZ: stall.posZ,
          reason: `overlaps blocked area (${hit.kind} at ${hit.posX},${hit.posZ})`,
        });
        totalDropped++;
        console.log(`drop  ${layout.layoutName} stall "${stall.name}" — overlaps ${hit.kind} area`);
      } else {
        (stall as { status?: string }).status =
          (stall as { color?: string }).color === BOOKED_COLOR ? 'BOOKED' : 'AVAILABLE';
        kept.push(stall);
      }
    }
    layout.stalls = kept;
    layout.source.seeded = kept.length;
  }

  writeFileSync(layoutsPath, JSON.stringify(layoutsFile, null, 2) + '\n');
  console.log(`wrote data/demo-layouts.json — ${totalDropped} conflicting stall(s) dropped`);
}

main();
