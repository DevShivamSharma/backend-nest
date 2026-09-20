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
}

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

  const dataRows: CsvRow[] = rows.slice(1).map((r) => ({
    id: r[cId],
    hall_id: r[cHallId],
    layout_data: r[cLayoutData],
    length: r[cLength],
    breadth: r[cBreadth],
  }));

  const shapes: Record<
    string,
    {
      hallName: string;
      prodHallId: number;
      source: { csvRowId: number; areas: { outside: number; wall: number; zone: number } };
      blockedAreas: BlockedArea[];
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

    shapes[demo.name] = {
      hallName: demo.name,
      prodHallId: demo.hallId,
      source: {
        csvRowId: Number(best.row.id),
        areas: { outside: count('outside'), wall: count('wall'), zone: count('zone') },
      },
      blockedAreas,
    };

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

    (layout.hall as { blockedAreas?: BlockedArea[] }).blockedAreas = shape.blockedAreas;
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
