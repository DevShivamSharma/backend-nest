import type {
  BlockedArea,
  HallAmenity,
  HallCompass,
  HallLegend,
  HallMarker,
} from '../layouts/entities/hall.entity';
import { validateHallGeometry } from '../layouts/placement/hall-geometry';
import type {
  HallOpening,
  HallZone,
  OpeningFacing,
  Point,
  ZoneKind,
} from '../layouts/placement/placement-rules';
import {
  Box,
  CadDrawing,
  boxContains,
  boxOf,
  cleanRing,
  polygonArea,
  pointInPolygon,
  segmentDistance,
  simplifyRing,
} from './cad-drawing';
import { coveredRegions, crossingStrips, enclosedAreas, splitBySeeds, traceOutlines } from './outline-trace';

/**
 * Floor-plan analysis: from a drawing to hall drafts in the planner's own structure.
 *
 * Deterministic, no AI. Everything is recognised from what CAD plans reliably carry:
 *   - text labels ("TOILET (M)", "LIFT", "EMERGENCY EXIT", "GATE 5C", "LEGEND:"),
 *   - layer names (AIA-style "A-WALL", "SS-SMOKE CURTAIN", "SS-EMMR EXIT SYMB", "AS-COLS"),
 *   - block names ("LIFT CAR", "wash-basin", "north arrow").
 * Nothing is saved here: the result is a proposal the planner reviews and corrects.
 *
 * Output coordinates are the planner's: metres, centre-origin at the hall outline's bounding-box
 * centre, X right, Z DOWN the plan (drawing Y up is flipped).
 *
 * A drawing can hold more than one outline that looks like a hall (a plan with the neighbouring
 * halls, the site boundary...). Up to three candidates are returned, best first, each a complete
 * draft, so choosing another outline in the review needs no second upload.
 */

export interface ImportedAmenity extends HallAmenity {
  id: string;
  /** How it was found: a text label, a CAD symbol (block) or a layer. */
  source: 'label' | 'symbol' | 'layer';
}

export interface HallDraft {
  id: string;
  /** How the outline was found, for the review screen. */
  outlineLabel: string;
  name: string;
  width: number;
  length: number;
  areaM2: number;
  boundary: Point[];
  amenities: ImportedAmenity[];
  markers: HallMarker[];
  openings: HallOpening[];
  zones: HallZone[];
  blockedAreas: BlockedArea[];
  legends: HallLegend[];
  compass: HallCompass | null;
  /** Plan linework for the review underlay: flat [x1, z1, x2, z2, ...] metres. */
  linework: number[];
  /**
   * Where this draft's frame centre lies in the overview's frame (metres), so a point converts
   * as overview = draft + origin. The overview's own origin is {0, 0}.
   */
  origin: Point;
}

/** A closed area of the plan the user can make a hall from (overview frame, metres). */
export interface RoomOutline {
  id: string;
  label: string;
  areaM2: number;
  polygon: Point[];
}

export interface HallImportResult {
  fileName: string;
  format: 'dxf' | 'pdf';
  scale: { metresPerUnit: number; known: boolean; source: string };
  /**
   * false: `candidates` are alternative readings of ONE hall (pick one).
   * true: the plan holds several halls and `candidates` are those halls (import each).
   */
  multiHall: boolean;
  candidates: HallDraft[];
  /**
   * The whole plan in one frame: every facility, zone, pillar and label found, for making a
   * hall from any area the user picks or draws when no suggestion fits.
   */
  overview: HallDraft;
  /** Closed areas of the plan, largest first, to pick a hall from. */
  rooms: RoomOutline[];
  warnings: string[];
  stats: { layers: number; shapes: number; texts: number; symbols: number };
}

const MAX_CANDIDATES = 3;
const MAX_OUTLINE_VERTICES = 400;
const MAX_LINEWORK_SEGMENTS = 20_000;
const MAX_OVERVIEW_SEGMENTS = 30_000;
const MAX_ROOMS = 40;
const MAX_AMENITIES = 300;
const MAX_MARKERS = 80;
const MAX_ZONES = 120;
const MAX_PILLARS = 600;

/** Layers that are never the hall outline. */
const NOT_OUTLINE =
  /title|border|frame|sheet|viewport|defpoints|stall|number|text|anno|dim|grid|furn|tree|plant|landscape|light|lite|seat|patt|jali|glaz|door|col|stair|toilet|sanr|smoke|exit|symb|hatch|area|elev/i;
const OUTLINE_STRONG = /base\s*shell|shell|hall[\s_-]*(outline|boundary|line)|boundary|outline|footprint/i;
const OUTLINE_WALL = /wall/i;
/** Layers whose lines enclose a hall: walls, shell, glazing, columns. Landscape walls are not. */
const TRACE_LAYER = /wall|shell|glaz|extw|facade|a-col|as-cols|curtain/i;
const NOT_TRACE_LAYER = /(^|\$|\|)ld-|landscape|planter|kerb|rcc wall|patt|hatch/i;
/** Layers worth drawing in the review underlay, most useful first. */
const LINEWORK_PRIORITY: RegExp[] = [/shell|boundary|outline|wall/i, /door|gate|stair|lift|toilet|sanr|exit/i, /col|partition|facia|fascia/i];
const LINEWORK_SKIP = /hatch|patt|tree|plant|landscape|light|lite|dim|text|anno|furn|seat|jali|glaz|pipe|viewport|defpoints/i;

const HALL_NAME = /\b(?:exhibition\s*)?hall\s*[-–#]?\s*(\d{1,2}\s*[a-z]?)\b/i;

interface Classified {
  kind: string;
  label: string;
}

/** A text label -> the amenity it names, or null. Order matters (female before male...). */
export function classifyLabel(raw: string): Classified | null {
  const text = raw.toLowerCase();
  if (text.length > 70) return null;
  if (/drinking\s*water|water\s*(cooler|fountain)/.test(text)) return { kind: 'drinking-water', label: 'Drinking water' };
  if (/emergency\s*exit|fire\s*exit/.test(text)) return { kind: 'emergency-exit', label: 'Emergency exit' };
  if (/cargo\s*(lift|elevator)|goods\s*lift/.test(text)) return { kind: 'lift', label: 'Cargo lift' };
  if (/(cargo|service)[\s/]*(entry|exit|gate|entrance)|cargo\s+from\s+gate/.test(text))
    return { kind: 'cargo-truck', label: 'Cargo / service entry' };
  if (/\b(lifts?|elevators?)\b|lift\s*lobby/.test(text)) return { kind: 'lift', label: /glass/.test(text) ? 'Glass lift' : 'Lift' };
  if (/\bstair(s|case)?\b/.test(text)) return { kind: 'stairs', label: 'Stairs' };
  if (/toilet|\bw\.?c\.?\b|wash\s*r(oo)?m|washroom|restroom|\blavatory/.test(text)) {
    if (/handi|disab|accessib|pwd|divyang/.test(text)) return { kind: 'toilet', label: 'Accessible toilet' };
    if (/female|ladies|women|\(\s*f\s*\)|\bf\b|\bher\b/.test(text)) return { kind: 'toilet-female', label: 'Toilet (Female)' };
    if (/\bmale\b|gents|\bmen\b|\(\s*m\s*\)|\bm\b|\bhis\b/.test(text)) return { kind: 'toilet-male', label: 'Toilet (Male)' };
    // Keep the plan's own name when it carries one ("TOILET 5G-A").
    const named = /^(toilets?|w\.?c\.?)\s+[a-z0-9][\w-]{0,8}$/i.test(raw.trim());
    return { kind: 'toilet', label: named ? titleCase(raw.trim()) : 'Toilets' };
  }
  const gate = /\bgate\s*[-#]?\s*(no\.?\s*)?([0-9]{1,2}[a-z]?)\b/i.exec(raw);
  if (gate) return { kind: 'entry-up', label: `Gate ${gate[2].toUpperCase()}` };
  if (/\b(entry|entrance)\b/.test(text)) return { kind: 'entry-up', label: 'Entry' };
  if (/^\s*exit\s*[-#]?\s*\w{0,3}\s*$/.test(text)) return { kind: 'emergency-exit', label: 'Exit' };
  return null;
}

/** A CAD block name -> the amenity its symbol draws, or null. */
export function classifyBlock(block: string): Classified | null {
  const name = block.split(/\$0\$|\|/).pop()!.toLowerCase();
  if (/lift\s*car|^lifts?\b|elevator/.test(name)) return { kind: 'lift', label: 'Lift' };
  if (/drinking|water[\s_-]*(fountain|cooler)/.test(name)) return { kind: 'drinking-water', label: 'Drinking water' };
  if (/exit[\s_-]*symb|emergency[\s_-]*exit|fire[\s_-]*exit/.test(name)) return { kind: 'emergency-exit', label: 'Emergency exit' };
  return null;
}

const STAIR_LAYER = /flor[\s_-]*strs|stair/i;
const SANITARY_BLOCK = /wash[\s_-]*basin|toilet|\bwc\b|urinal|sanitary|commode|pan\b/i;
const SANITARY_LAYER = /toilet|sanr|sanitary/i;
const EXIT_LAYER = /exit[\s_-]*symb|emmr[\s_-]*exit|emergency[\s_-]*exit/i;
const COLUMN_LAYER = /\bcols?\b|column|as-cols|a-col|pillar/i;
const NORTH_BLOCK = /north|compass|n[\s_-]?arrow/i;
const ZONE_LAYERS: Array<[RegExp, ZoneKind, string, string]> = [
  [/smoke[\s_-]*curtain/i, 'SMOKE_CURTAIN', 'Smoke curtain', '#7e57c2'],
  [/no[\s_-]*constr|non[\s_-]*constr|restricted/i, 'NO_CONSTRUCTION', 'No construction', '#8d6e63'],
  [/passage|gangway|aisle|fire[\s_-]*tender/i, 'PASSAGE', 'Passage', '#e53935'],
  [/exit[\s_-]*access|emergency[\s_-]*access/i, 'EMERGENCY_EXIT_ACCESS', 'Emergency exit access', '#fb8c00'],
];

const OPENING_KIND: Record<string, HallOpening['kind']> = {
  'entry-up': 'ENTRY',
  'emergency-exit': 'EMERGENCY',
  'cargo-truck': 'SERVICE',
};

export function analyseDrawing(drawing: CadDrawing, fileName: string): HallImportResult {
  const warnings = [...drawing.warnings];
  const extent = drawingExtent(drawing);
  let s = drawing.metresPerUnit;
  let known = s !== null;
  let source = drawing.scaleSource;

  if (s === null) {
    const fromLabels = scaleFromAreaLabels(drawing);
    if (fromLabels) {
      s = fromLabels.metresPerUnit;
      known = true;
      source = `Scale worked out from ${fromLabels.samples} stall area labels on the plan (e.g. "${fromLabels.example}")`;
    }
  }
  if (s === null) {
    s = guessScale(drawing, extent);
    known = drawing.format === 'dxf' && s !== null;
    if (drawing.format === 'pdf') {
      source = 'Scale not stated in the PDF — the hall area sets it';
    } else {
      source = 'Drawing units not set — assumed from the drawing size';
      warnings.push('The DXF does not state its units; check the hall size before saving.');
    }
    s ??= 1;
  }

  let considered: Outline[] = [];
  let outlines = findOutlines(drawing, s, extent, considered);
  if (!outlines.length) {
    warnings.push('No closed hall outline was found; the extent of the wall lines is used instead. Check the outline before saving.');
    outlines.push(fallbackOutline(drawing, extent));
  }

  let legends = findLegend(drawing, outlines[0].box);
  for (const sheet of drawing.sheets ?? []) {
    if (legends.length) break;
    legends = findLegend({ ...sheet, polylines: sheet.polylines ?? [] }, null);
  }
  if (!legends.length) warnings.push('No legend was found on the plan.');

  // The exhibition floors (inside the peripheral passage) are floor by definition: trace the wall
  // outlines again with them as known interior, so an opening wider than the tracer closes (a
  // rolling shutter with no wall line across it) cannot cut a bay of the hall out of its outline.
  const knownFloors = exhibitionFloors(drawing, legends, outlines[0], s);
  if (knownFloors.length) {
    const retraced: Outline[] = [];
    const again = findOutlines(drawing, s, extent, retraced, knownFloors.map((f) => f.ring));
    if (again.length) [outlines, considered] = [again, retraced];
  }

  // Several halls on one plan (Halls 2-5 in one drawing): one draft per hall.
  const split = splitHalls(drawing, legends, outlines[0], s);
  if (split) {
    const building = outlines[0].ring;
    const halls = split.owners;
    const centre = (b: Box) => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    const nearest = (x: number, y: number) => {
      let best = 0;
      let dist = Infinity;
      halls.forEach((h, i) => {
        const dx = Math.max(h.box.minX - x, 0, x - h.box.maxX);
        const dy = Math.max(h.box.minY - y, 0, y - h.box.maxY);
        const d = Math.hypot(dx, dy);
        if (d < dist) [best, dist] = [i, d];
      });
      return best;
    };
    const drafts = halls.map((hall, i) => {
      const margin = 12 / s!;
      // Inside the hall, or outside the building but closest to this hall (a gate, a toilet
      // block off the foyer): never counted for two halls.
      const owns = (x: number, y: number) =>
        pointInPolygon(x, y, hall.ring) ||
        (!pointInPolygon(x, y, building) && boxContains(hall.box, x, y, margin) && nearest(x, y) === i);
      const [cx] = centre(hall.box);
      // Hall titles are printed under (or over) the hall they name, within its width.
      const names = (x: number, y: number) =>
        x >= hall.box.minX - 5 / s! && x <= hall.box.maxX + 5 / s! && y >= hall.box.minY - 45 / s! && y <= hall.box.maxY + 45 / s!;
      // The hall you plan stalls in is its exhibition floor (inside and including its
      // peripheral passage); toilets, lifts and stairs stay outside it, in the service cores.
      return buildDraft(drawing, split.floors[i], s!, i, fileName, legends, { owns, names, nearX: cx });
    });
    drafts.forEach((d, i) => ((d as HallDraft & { box?: Box }).box = split.floors[i].box));
    drafts.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    drafts.forEach((d, i) => (d.id = `hall-${i + 1}`));
    warnings.unshift(`This plan holds ${drafts.length} halls (${drafts.map((d) => d.name).join(', ')}). Check and save each one.`);
    const site = siteOf([...split.owners, ...outlines], s);
    placeDrafts(drafts, s, site);
    const overview = buildOverview(drawing, site, s, fileName, legends);
    const rooms = roomOutlines([...split.floors, ...split.owners, ...outlines, ...considered], site, s);
    return result(drawing, fileName, s, known, source, true, drafts, warnings, overview, rooms);
  }

  // One hall: its exhibition floor (inside its peripheral passage) comes first; the whole
  // building stays available. Services in the building belong to the hall either way.
  const building = outlines[0];
  const floor = exhibitionFloors(drawing, legends, building, s)[0];
  const buildingScope = floor
    ? {
        owns: (x: number, y: number) => pointInPolygon(x, y, building.ring) || boxContains(building.box, x, y, 12 / s!),
      }
    : undefined;
  if (floor) outlines.unshift(floor);

  // A plan can carry the same hall twice (an xref inserted at two places): offer it once.
  const candidates: HallDraft[] = [];
  for (const outline of outlines) {
    const draft = buildDraft(drawing, outline, s!, candidates.length, fileName, legends, buildingScope);
    (draft as HallDraft & { box?: Box }).box = outline.box;
    const copy = candidates.some(
      (c) =>
        Math.abs(c.width - draft.width) <= 0.01 * c.width &&
        Math.abs(c.length - draft.length) <= 0.01 * c.length &&
        Math.abs(c.areaM2 - draft.areaM2) <= 0.02 * c.areaM2,
    );
    // A small room the tracer also closed is not a hall alternative.
    const tooSmall = candidates.length > 0 && draft.areaM2 < Math.max(500, 0.2 * candidates[0].areaM2);
    if (!copy && !tooSmall && candidates.length < MAX_CANDIDATES) candidates.push(draft);
  }
  if (!candidates.some((c) => c.amenities.length)) {
    warnings.push('No toilets, lifts, gates or exits were recognised. Add them on the plan before saving.');
  }

  const site = siteOf(outlines, s);
  placeDrafts(candidates, s, site);
  const overview = buildOverview(drawing, site, s, fileName, legends);
  const rooms = roomOutlines([...outlines, ...considered], site, s);
  return result(drawing, fileName, s, known, source, false, candidates, warnings, overview, rooms);
}

/** The part of the drawing the overview shows: every outline found, with room around it. */
function siteOf(outlines: Outline[], s: number): Box {
  const margin = 20 / s;
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const o of outlines) {
    box.minX = Math.min(box.minX, o.box.minX);
    box.minY = Math.min(box.minY, o.box.minY);
    box.maxX = Math.max(box.maxX, o.box.maxX);
    box.maxY = Math.max(box.maxY, o.box.maxY);
  }
  return { minX: box.minX - margin, minY: box.minY - margin, maxX: box.maxX + margin, maxY: box.maxY + margin };
}

/** Sets each draft's origin in the overview frame (the site's centre is its 0, 0). */
function placeDrafts(drafts: HallDraft[], s: number, site: Box): void {
  const sx = (site.minX + site.maxX) / 2;
  const sy = (site.minY + site.maxY) / 2;
  for (const draft of drafts) {
    const d = draft as HallDraft & { box?: Box };
    const b = d.box!;
    draft.origin = { x: round(((b.minX + b.maxX) / 2 - sx) * s), z: round(-((b.minY + b.maxY) / 2 - sy) * s) };
    delete d.box;
  }
}

/** The whole site as one draft: its boundary is the site rectangle. */
function buildOverview(d: CadDrawing, site: Box, s: number, fileName: string, legends: HallLegend[]): HallDraft {
  const ring = [site.minX, site.minY, site.maxX, site.minY, site.maxX, site.maxY, site.minX, site.maxY];
  const outline: Outline = { ring, box: site, area: polygonArea(ring), label: 'Whole plan' };
  const draft = buildDraft(d, outline, s, 0, fileName, legends, { owns: (x, y) => boxContains(site, x, y) }, MAX_OVERVIEW_SEGMENTS);
  draft.id = 'overview';
  draft.origin = { x: 0, z: 0 };
  return draft;
}

/** Distinct closed areas, in the overview frame, that the planner accepts as a hall outline. */
function roomOutlines(outlines: Outline[], site: Box, s: number): RoomOutline[] {
  const sx = (site.minX + site.maxX) / 2;
  const sy = (site.minY + site.maxY) / 2;
  const kept: Outline[] = [];
  for (const o of [...outlines].sort((a, b) => b.area - a.area)) {
    if (kept.length >= MAX_ROOMS) break;
    if (!boxContains(site, (o.box.minX + o.box.maxX) / 2, (o.box.minY + o.box.maxY) / 2)) continue;
    if (kept.some((k) => sameBox(k.box, o.box))) continue;
    kept.push(o);
  }
  const rooms: RoomOutline[] = [];
  for (const o of kept) {
    const ring = outlineRing(o.ring, s, 0.3);
    if (!ring) continue;
    const polygon: Point[] = [];
    for (let i = 0; i < ring.length; i += 2) polygon.push({ x: round((ring[i] - sx) * s), z: round(-(ring[i + 1] - sy) * s) });
    const areaM2 = Math.round(polygonArea(ring) * s * s);
    rooms.push({ id: `room-${rooms.length + 1}`, label: o.label || `Area · ${areaM2.toLocaleString('en-IN')} m²`, areaM2, polygon });
  }
  return rooms;
}

function result(
  drawing: CadDrawing,
  fileName: string,
  s: number,
  known: boolean,
  source: string,
  multiHall: boolean,
  candidates: HallDraft[],
  warnings: string[],
  overview: HallDraft,
  rooms: RoomOutline[],
): HallImportResult {
  return {
    fileName,
    format: drawing.format,
    scale: { metresPerUnit: s, known, source },
    multiHall,
    candidates,
    overview,
    rooms,
    warnings,
    stats: {
      layers: drawing.layers.length,
      shapes: drawing.polylines.length + drawing.fills.length,
      texts: drawing.texts.length,
      symbols: drawing.inserts.length,
    },
  };
}

/**
 * The halls of a plan that draws several: each hall's stall floor is the area its peripheral
 * passage (the legend's "PERIPHERAL PASSAGE / NO CONSTRUCTION" colour) encloses. With two or
 * more such floors inside the building, the building is split between them. null for a plan of
 * one hall.
 */
function splitHalls(
  d: CadDrawing,
  legends: HallLegend[],
  building: Outline,
  s: number,
): { floors: Outline[]; owners: Outline[] } | null {
  let floors = exhibitionFloors(d, legends, building, s);
  // One enclosed floor can still hold two halls, divided only by a movable partition (Halls 3
  // and 4): split it when more than one hall title stands under it.
  let seeds = floors.flatMap((f) => splitSharedFloor(d, legends, f.ring, building.ring, s));
  // An open foyer can join the wall/peripheral outlines while the two named hall grids
  // remain separate. Require a distinct local hall title for every grid floor.
  if (seeds.length < 2) {
    floors = labelledGridFloors(d, building, s);
    seeds = floors.map((f) => f.ring);
  }
  if (seeds.length < 2) return null;

  const result: { floors: Outline[]; owners: Outline[] } = { floors: [], owners: [] };
  splitBySeeds(building.ring, seeds, s).forEach((ring, i) => {
    const owner = ring && outlineRing(ring, s, 0.6);
    const floor = outlineRing(seeds[i], s, 0.3);
    if (!owner || !floor) return;
    const area = polygonArea(floor) * s * s;
    result.owners.push({ ring: owner, box: boxOf(owner), area: polygonArea(owner), label: '' });
    result.floors.push({
      ring: floor,
      box: boxOf(floor),
      area: area / (s * s),
      label: `Hall ${i + 1} of ${seeds.length} on this plan · exhibition floor ${Math.round(area).toLocaleString('en-IN')} m²`,
    });
  });
  return result.floors.length >= 2 ? result : null;
}

/** A conservative fallback for separately named exhibition grids joined by an open foyer. */
function labelledGridFloors(d: CadDrawing, building: Outline, s: number): Outline[] {
  const titlePattern = /^(?:exhibition\s*)?hall\s*[-–#]?\s*(\d{1,2}\s*[a-z]?)(?:\s+(?:ground|first)\s+floor)?$/i;
  const titles = d.texts.filter((t) => titlePattern.test(t.text.trim()));
  const number = (t: CadDrawing['texts'][number]) => titlePattern.exec(t.text.trim())![1].replace(/\s/g, '').toUpperCase();
  if (new Set(titles.map(number)).size < 2) return [];
  const grids = d.polylines.filter((p) => /^(?:stall[ _-]*)?grid(?:[ _-]*lines)?$/i.test(leaf(p.layer)));
  const floors = traceOutlines(grids, s, () => true).filter((f) =>
    f.area >= 400 && pointInPolygon((f.box.minX + f.box.maxX) / 2, (f.box.minY + f.box.maxY) / 2, building.ring),
  );
  if (floors.length < 2) return [];
  const named = new Set<string>();
  const result: Outline[] = [];
  for (const floor of floors) {
    const b = floor.box;
    const local = titles.filter((t) => t.x >= b.minX && t.x <= b.maxX &&
      t.y >= b.minY - 45 / s && t.y <= b.maxY + 45 / s);
    const names = [...new Set(local.map(number))];
    // Multiple grid islands of ONE hall must never become separate halls.
    if (names.length !== 1 || named.has(names[0])) return [];
    // A few structural axes are insufficient evidence of an exhibition floor grid.
    const horizontal = new Set<number>();
    const vertical = new Set<number>();
    for (const p of grids) {
      for (let i = 0; i + 3 < p.points.length; i += 2) {
        const [x1, y1, x2, y2] = p.points.slice(i, i + 4);
        if (!boxContains(b, (x1 + x2) / 2, (y1 + y2) / 2, 0.3 / s)) continue;
        if (Math.abs(y2 - y1) * s < 0.05 && Math.abs(x2 - x1) > (b.maxX - b.minX) * 0.25) horizontal.add(Math.round(y1 * s * 10));
        if (Math.abs(x2 - x1) * s < 0.05 && Math.abs(y2 - y1) > (b.maxY - b.minY) * 0.25) vertical.add(Math.round(x1 * s * 10));
      }
    }
    if (horizontal.size < 8 || vertical.size < 8) return [];
    const ring = outlineRing(floor.ring, s, 0.3);
    if (!ring) return [];
    named.add(names[0]);
    result.push({ ring, box: boxOf(ring), area: polygonArea(ring), label: 'Exhibition floor traced from its labelled grid' });
  }
  return result;
}

/**
 * The stall floors of a plan: the areas its peripheral passage (the legend's "PERIPHERAL
 * PASSAGE / NO CONSTRUCTION" colour) encloses, each with that passage band around it, inside
 * the building. Largest first; empty when the plan has no such legend or band.
 */
function exhibitionFloors(d: CadDrawing, legends: HallLegend[], building: Outline, s: number): Outline[] {
  const band =
    legends.find((l) => l.colorCode && /peripheral/i.test(l.label)) ??
    legends.find((l) => l.colorCode && /no[\s-]*construction/i.test(l.label) && !/smoke|curtain/i.test(l.label));
  if (!band?.colorCode) return [];
  const pad = 2 / s;
  const box = { minX: building.box.minX - pad, minY: building.box.minY - pad, maxX: building.box.maxX + pad, maxY: building.box.maxY + pad };
  return enclosedAreas(paintSegments(d, band.colorCode), box, s, { closeMetres: 1.5, minArea: 400, withBandMetres: 8 })
    .filter((f) => pointInPolygon((f.box.minX + f.box.maxX) / 2, (f.box.minY + f.box.maxY) / 2, building.ring))
    .flatMap((f) => {
      const ring = outlineRing(f.ring, s, 0.3);
      if (!ring) return [];
      const area = polygonArea(ring) * s * s;
      return [{ ring, box: boxOf(ring), area: area / (s * s), label: `Exhibition floor inside the peripheral passage · ${Math.round(area).toLocaleString('en-IN')} m²` }];
    });
}

// --- outline -------------------------------------------------------------------------------

interface Outline {
  ring: number[]; // drawing units, y up
  box: Box;
  area: number; // drawing units²
  label: string;
}

function drawingExtent(d: CadDrawing): Box {
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (pts: number[]) => {
    const b = boxOf(pts);
    box.minX = Math.min(box.minX, b.minX);
    box.minY = Math.min(box.minY, b.minY);
    box.maxX = Math.max(box.maxX, b.maxX);
    box.maxY = Math.max(box.maxY, b.maxY);
  };
  for (const p of d.polylines) grow(p.points);
  for (const t of d.texts) grow([t.x, t.y]);
  return box;
}

/**
 * The exact scale of a stall plan without units: stalls carry their area as a label ("12m²"),
 * so each label and the closed outline around it give metres² per unit². Used only when most
 * labelled stalls agree, so a label that sits in the wrong box cannot skew it.
 */
export function scaleFromAreaLabels(d: CadDrawing): { metresPerUnit: number; samples: number; example: string } | null {
  const labels = d.texts
    .map((t) => ({ t, m: /^(\d{1,4}(?:\.\d+)?)\s*(?:m²|m2|sq\.?\s?m|sqm)$/i.exec(t.text.trim()) }))
    .filter((l): l is { t: CadDrawing['texts'][number]; m: RegExpExecArray } => l.m !== null && Number(l.m[1]) > 0)
    .slice(0, 400);
  if (labels.length < 3) return null;
  const boxes = d.polylines
    .filter((p) => p.closed && p.points.length >= 6 && p.points.length <= 64)
    .map((p) => ({ p, b: boxOf(p.points), area: polygonArea(p.points) }))
    .filter((x) => x.area > 0);

  const ratios: number[] = [];
  for (const { t, m } of labels) {
    // The smallest closed outline around the label is its stall.
    let best: { area: number } | null = null;
    for (const x of boxes) {
      if (!boxContains(x.b, t.x, t.y) || (best && x.area >= best.area)) continue;
      if (pointInPolygon(t.x, t.y, x.p.points)) best = x;
    }
    if (best) ratios.push(Number(m[1]) / best.area);
  }
  if (ratios.length < 3) return null;
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const agreeing = ratios.filter((r) => Math.abs(r - median) <= 0.06 * median).length;
  if (agreeing < 3 || agreeing < 0.6 * ratios.length) return null;
  return { metresPerUnit: Math.sqrt(median), samples: agreeing, example: labels[0].t.text.trim() };
}

/** For drawings without units: the factor that makes the hall's walls (or else its largest shape) hall-sized. */
function guessScale(d: CadDrawing, extent: Box): number | null {
  if (d.format === 'pdf') {
    const walls = d.polylines.filter((p) => TRACE_LAYER.test(leaf(p.layer)) && !NOT_TRACE_LAYER.test(leaf(p.layer)));
    if (walls.length >= 20) {
      const b = boxOf(walls.flatMap((p) => p.points));
      const size = Math.max(b.maxX - b.minX, b.maxY - b.minY);
      if (size > 0) return 150 / size; // a placeholder; the hall area in the review sets the real scale
    }
  }
  const largest = d.polylines
    .filter((p) => p.closed && p.points.length >= 6 && !NOT_OUTLINE.test(leaf(p.layer)))
    .map((p) => boxOf(p.points))
    .filter((b) => b.maxX - b.minX < 0.97 * (extent.maxX - extent.minX))
    .map((b) => Math.max(b.maxX - b.minX, b.maxY - b.minY))
    .sort((a, b) => b - a)[0];
  const size = largest ?? Math.max(extent.maxX - extent.minX, extent.maxY - extent.minY);
  if (!Number.isFinite(size) || size <= 0) return null;
  if (d.format === 'pdf') return 120 / size; // placeholder until the user calibrates
  // Pick the unit that makes the shape 20-600 m across.
  for (const unit of [1, 0.001, 0.01, 0.0254, 0.3048]) {
    const metres = size * unit;
    if (metres >= 20 && metres <= 600) return unit;
  }
  return null;
}

function findOutlines(
  d: CadDrawing,
  s: number,
  extent: Box,
  considered: Outline[] = [],
  /** Areas known to be inside a hall (its exhibition floors): never outside a traced outline. */
  interior: number[][] = [],
): Outline[] {
  const extentW = extent.maxX - extent.minX;
  const extentH = extent.maxY - extent.minY;
  const hallTexts = d.texts.filter((t) => HALL_NAME.test(t.text));
  const rings: Array<{ ring: number[]; layer: string }> = [];
  for (const p of d.polylines) {
    if (p.closed && p.points.length >= 6 && !NOT_OUTLINE.test(leaf(p.layer))) rings.push({ ring: p.points, layer: p.layer });
  }
  for (const f of d.fills) {
    if (!OUTLINE_STRONG.test(leaf(f.layer))) continue;
    for (const loop of f.loops) if (loop.length >= 6) rings.push({ ring: loop, layer: f.layer });
  }

  const scored: Array<Outline & { score: number }> = [];
  for (const { ring, layer } of rings) {
    const area = polygonArea(ring) * s * s;
    if (area < 150 || area > 80_000) continue;
    const box = boxOf(ring);
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    if (Math.max(w, h) / Math.max(Math.min(w, h), 1e-9) > 12) continue;
    if (w >= 0.97 * extentW && h >= 0.97 * extentH) continue; // the sheet frame
    const inside = hallTexts.filter((t) => pointInPolygon(t.x, t.y, ring));
    const names = new Set(inside.map((t) => HALL_NAME.exec(t.text)![1].replace(/\s/g, '').toUpperCase()));
    if (!OUTLINE_STRONG.test(leaf(layer)) && !OUTLINE_WALL.test(leaf(layer)) && area < 1000) continue;
    let weight = OUTLINE_STRONG.test(leaf(layer)) ? 3 : OUTLINE_WALL.test(leaf(layer)) ? 2 : 1;
    if (names.size === 1) weight *= 1.5;
    if (names.size > 1) weight *= 0.4; // a site boundary around several halls
    const kind = OUTLINE_STRONG.test(leaf(layer)) ? 'Hall outline' : OUTLINE_WALL.test(leaf(layer)) ? 'Wall outline' : 'Closed outline';
    scored.push({
      ring,
      box,
      area: area / (s * s),
      label: `${kind} on layer "${shortLayer(layer)}" · ${Math.round(area).toLocaleString('en-IN')} m²`,
      score: area * weight,
    });
  }
  const exact = scored.length;

  // Walls drawn as separate lines: trace the enclosed area instead.
  const isWall = (l: string) => TRACE_LAYER.test(leaf(l)) && !NOT_TRACE_LAYER.test(leaf(l));
  for (const traced of traceOutlines(d.polylines, s, isWall, interior)) {
    if (traced.area > 80_000) continue;
    const names = hallNamesInside(hallTexts, traced.ring);
    const weight = 2 * (names === 1 ? 1.5 : names > 1 ? 0.4 : 1);
    scored.push({
      ring: traced.ring,
      box: traced.box,
      area: traced.area / (s * s),
      label: `Traced from the wall lines · ${Math.round(traced.area).toLocaleString('en-IN')} m²`,
      score: traced.area * weight,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  considered.push(...scored);

  const picked: Outline[] = [];
  for (const candidate of scored) {
    if (picked.length >= MAX_CANDIDATES + 2) break;
    if (picked.some((p) => sameBox(p.box, candidate.box))) continue;
    // Traced outlines are staircases of raster cells: straighten them at the cell size.
    const traced = scored.indexOf(candidate) >= 0 && candidate.label.startsWith('Traced');
    const ring = outlineRing(candidate.ring, s, traced ? 0.6 : 0.05);
    if (!ring) continue;
    picked.push({ ...candidate, ring });
  }
  void exact;
  return picked;
}

function hallNamesInside(texts: CadDrawing['texts'], ring: number[]): number {
  const names = new Set(
    texts
      .filter((t) => pointInPolygon(t.x, t.y, ring))
      .map((t) => HALL_NAME.exec(t.text)![1].replace(/\s/g, '').toUpperCase()),
  );
  return names.size;
}

/** Cleans and simplifies an outline until the planner accepts it; null if it never does. */
function outlineRing(ring: number[], s: number, toleranceMetres = 0.05): number[] | null {
  let tolerance = toleranceMetres / s;
  let out = cleanRing(ring, 1e-4 / s);
  for (let attempt = 0; attempt < 8; attempt++) {
    const simplified = simplifyRing(out, tolerance);
    if (simplified.length / 2 <= MAX_OUTLINE_VERTICES && validPolygon(simplified.map((v) => v * s))) {
      return simplified;
    }
    out = simplified;
    tolerance *= 2;
  }
  return null;
}

function fallbackOutline(d: CadDrawing, extent: Box): Outline {
  const walls = d.polylines.filter((p) => OUTLINE_WALL.test(leaf(p.layer)));
  const pts = (walls.length ? walls : d.polylines).flatMap((p) => p.points);
  const box = pts.length ? boxOf(pts) : extent;
  const ring = [box.minX, box.minY, box.maxX, box.minY, box.maxX, box.maxY, box.minX, box.maxY];
  return {
    ring,
    box,
    area: (box.maxX - box.minX) * (box.maxY - box.minY),
    label: walls.length ? 'Extent of the wall lines' : 'Extent of the drawing',
  };
}

function sameBox(a: Box, b: Box): boolean {
  const size = Math.max(a.maxX - a.minX, a.maxY - a.minY, b.maxX - b.minX, b.maxY - b.minY);
  return (
    Math.abs(a.minX - b.minX) < 0.02 * size &&
    Math.abs(a.maxX - b.maxX) < 0.02 * size &&
    Math.abs(a.minY - b.minY) < 0.02 * size &&
    Math.abs(a.maxY - b.maxY) < 0.02 * size
  );
}

// --- one hall draft ------------------------------------------------------------------------

function buildDraft(
  d: CadDrawing,
  outline: Outline,
  s: number,
  index: number,
  fileName: string,
  legends: HallLegend[],
  /** For one hall of a multi-hall plan: what belongs to it, and where its title may be. */
  scope?: { owns: (x: number, y: number) => boolean; names?: (x: number, y: number) => boolean; nearX?: number },
  maxSegments = MAX_LINEWORK_SEGMENTS,
): HallDraft {
  const { box, ring } = outline;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const plan = (x: number, y: number): Point => ({ x: round((x - cx) * s), z: round(-(y - cy) * s) });
  const size = Math.max(box.maxX - box.minX, box.maxY - box.minY);
  // Amenities and labels may sit just outside the walls (toilet blocks off the foyer).
  const margin = Math.max(12 / s, 0.08 * size);
  const inScope = scope?.owns ?? ((x: number, y: number) => boxContains(box, x, y, margin));
  const inside = (x: number, y: number) => pointInPolygon(x, y, ring);

  const boundary = ringToPlan(ring, plan);
  const amenities = findAmenities(d, s, inScope, plan);
  const markers = findMarkers(d, inScope, plan, amenities);
  const openings = findOpenings(amenities, boundary);
  const painted = legendZones(d, legends, s, box, inside, plan);
  const zones = [
    ...painted,
    // Layer-named zones only for kinds the legend did not already paint.
    ...findZones(d, s, inside, plan).filter((z) => !painted.some((p) => p.kind === z.kind)),
  ].map((z, i) => ({ ...z, id: `z-${i + 1}` }));
  const blockedAreas = findPillars(d, s, inside, plan);
  const compass = findCompass(d, s, box, margin, plan);

  return {
    id: `outline-${index + 1}`,
    outlineLabel: outline.label,
    name: hallName(d, ring, inScope, scope) ?? nameFromFile(fileName),
    width: round((box.maxX - box.minX) * s),
    length: round((box.maxY - box.minY) * s),
    areaM2: Math.round(polygonArea(ring) * s * s),
    boundary,
    amenities,
    markers,
    openings,
    zones,
    blockedAreas,
    legends,
    compass,
    linework: linework(d, s, box, margin, plan, maxSegments),
    origin: { x: 0, z: 0 },
  };
}

function ringToPlan(ring: number[], plan: (x: number, y: number) => Point): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < ring.length; i += 2) points.push(plan(ring[i], ring[i + 1]));
  return points;
}

function hallName(
  d: CadDrawing,
  ring: number[],
  inScope: (x: number, y: number) => boolean,
  scope?: { names?: (x: number, y: number) => boolean; nearX?: number },
): string | null {
  // "PASSAGE TO HALL-2", "TO GATE 1 & 4, HALL 2-5": directions to other halls, not this one's name.
  const direction = /^\s*(to|towards|from|via)\b|passage\s+to|\bto\s+hall/i;
  const rank = (t: CadDrawing['texts'][number]) =>
    (/exhibition\s*hall/i.test(t.text) ? 4 : 0) + (pointInPolygon(t.x, t.y, ring) ? 2 : 0) + (/floor/i.test(t.text) ? 1 : 0);
  const candidates = d.texts.filter(
    (t) => HALL_NAME.test(t.text) && !direction.test(t.text) && (!scope?.names || scope.names(t.x, t.y)),
  );
  const texts = (candidates.some((t) => /exhibition\s*hall/i.test(t.text)) ? candidates : candidates.filter((t) => inScope(t.x, t.y)))
    .sort(
      (a, b) =>
        rank(b) - rank(a) ||
        (scope?.nearX !== undefined ? Math.abs(a.x - scope.nearX) - Math.abs(b.x - scope.nearX) : 0) ||
        b.height - a.height,
    );
  const best = texts[0];
  if (!best) return null;
  const number = HALL_NAME.exec(best.text)![1].replace(/\s/g, '').toUpperCase();
  const floorText = `${best.text} ${d.texts.filter((t) => Math.hypot(t.x - best.x, t.y - best.y) < best.height * 4).map((t) => t.text).join(' ')}`;
  const floor = /ground\s*floor|\bg\.?\s?f\b/i.test(floorText) ? ' GF' : /first\s*floor|\bf\.?\s?f\b/i.test(floorText) ? ' FF' : '';
  return `Hall ${number}${floor}`;
}

function nameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  const match = HALL_NAME.exec(base);
  if (match) return `Hall ${match[1].replace(/\s/g, '').toUpperCase()}`;
  // ITPO drawing names: "H5G" = Hall 5 ground floor, "H4F" = Hall 4 first floor.
  const short = /(?:^|[^a-z0-9])h(\d{1,2}[a-z]?)([gf])(?![a-z0-9])/i.exec(base);
  if (short) return `Hall ${short[1].toUpperCase()} ${short[2].toUpperCase() === 'G' ? 'GF' : 'FF'}`;
  return base.slice(0, 60) || 'Imported hall';
}

function findAmenities(
  d: CadDrawing,
  s: number,
  inScope: (x: number, y: number) => boolean,
  plan: (x: number, y: number) => Point,
): ImportedAmenity[] {
  const found: Array<Classified & { x: number; y: number; source: ImportedAmenity['source'] }> = [];

  for (const t of d.texts) {
    if (!inScope(t.x, t.y)) continue;
    const c = classifyLabel(t.text);
    if (c) found.push({ ...c, x: t.x, y: t.y, source: 'label' });
  }
  for (const ins of d.inserts) {
    if (!inScope(ins.x, ins.y)) continue;
    const c = classifyBlock(ins.block);
    if (c) found.push({ ...c, x: ins.x, y: ins.y, source: 'symbol' });
    else if (EXIT_LAYER.test(leaf(ins.layer))) found.push({ kind: 'emergency-exit', label: 'Emergency exit', x: ins.x, y: ins.y, source: 'layer' });
  }
  for (const p of d.polylines) {
    if (!EXIT_LAYER.test(leaf(p.layer))) continue;
    const b = boxOf(p.points);
    const [x, y] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    if (inScope(x, y) && Math.max(b.maxX - b.minX, b.maxY - b.minY) * s < 6) {
      found.push({ kind: 'emergency-exit', label: 'Emergency exit', x, y, source: 'layer' });
    }
  }

  // Toilet rooms without a label: clusters of sanitary fixtures or toilet-layer fills.
  const toiletLabels = found.filter((f) => f.kind.startsWith('toilet'));
  const fixtures: Array<[number, number]> = [];
  for (const ins of d.inserts) if (inScope(ins.x, ins.y) && SANITARY_BLOCK.test(ins.block.split(/\$0\$|\|/).pop()!)) fixtures.push([ins.x, ins.y]);
  for (const p of d.polylines) {
    if (!SANITARY_LAYER.test(leaf(p.layer))) continue;
    const b = boxOf(p.points);
    const [x, y] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    if (inScope(x, y) && Math.max(b.maxX - b.minX, b.maxY - b.minY) * s < 3) fixtures.push([x, y]);
  }
  for (const f of d.fills) {
    if (!SANITARY_LAYER.test(leaf(f.layer))) continue;
    const b = boxOf(f.loops.flat());
    const [x, y] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    if (inScope(x, y)) fixtures.push([x, y]);
  }
  for (const [x, y, count] of cluster(fixtures, 8 / s)) {
    if (count < 4) continue;
    if (toiletLabels.some((t) => Math.hypot(t.x - x, t.y - y) * s < 12)) continue;
    found.push({ kind: 'toilet', label: 'Toilets', x, y, source: 'symbol' });
  }

  // Staircases drawn as symbols without a label: dense clusters of stair-layer lines.
  const stairLines: Array<[number, number]> = [];
  for (const p of d.polylines) {
    if (!STAIR_LAYER.test(leaf(p.layer))) continue;
    const b = boxOf(p.points);
    const [x, y] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    if (inScope(x, y) && Math.max(b.maxX - b.minX, b.maxY - b.minY) * s < 15) stairLines.push([x, y]);
  }
  for (const [x, y, count] of cluster(stairLines, 5 / s)) {
    if (count >= 8) found.push({ kind: 'stairs', label: 'Stairs', x, y, source: 'layer' });
  }

  // One icon per place: the same kind within a few metres is one amenity; labels win.
  const rank = { label: 0, symbol: 1, layer: 2 } as const;
  found.sort((a, b) => rank[a.source] - rank[b.source]);
  const kept: typeof found = [];
  for (const f of found) {
    // A symbol found by its layer is often several paths (PDF): merge those more widely.
    const radius = f.source === 'layer' ? 8 : f.kind === 'entry-up' || f.kind === 'emergency-exit' ? 3 : 6;
    if (kept.some((k) => k.kind === f.kind && Math.hypot(k.x - f.x, k.y - f.y) * s < radius)) continue;
    kept.push(f);
    if (kept.length >= MAX_AMENITIES) break;
  }
  return kept.map((f, i) => ({ id: `a-${i + 1}`, kind: f.kind, label: f.label, position: plan(f.x, f.y), source: f.source }));
}

/** Greedy clustering: [x, y, count] per cluster of points within `radius`. */
function cluster(points: Array<[number, number]>, radius: number): Array<[number, number, number]> {
  const clusters: Array<{ x: number; y: number; n: number }> = [];
  for (const [x, y] of points) {
    const c = clusters.find((k) => Math.hypot(k.x - x, k.y - y) < radius);
    if (c) {
      c.x = (c.x * c.n + x) / (c.n + 1);
      c.y = (c.y * c.n + y) / (c.n + 1);
      c.n++;
    } else clusters.push({ x, y, n: 1 });
  }
  return clusters.map((c) => [c.x, c.y, c.n]);
}

function findMarkers(
  d: CadDrawing,
  inScope: (x: number, y: number) => boolean,
  plan: (x: number, y: number) => Point,
  amenities: ImportedAmenity[],
): HallMarker[] {
  const markers: HallMarker[] = [];
  for (const t of d.texts) {
    if (markers.length >= MAX_MARKERS || !inScope(t.x, t.y) || t.text.length > 40) continue;
    if (!/foyer|lobby|atrium|ramp|\bgate\b|hall\s*[-–]?\s*\d/i.test(t.text)) continue;
    const position = plan(t.x, t.y);
    const text = t.text.replace(/\s+/g, ' ').trim();
    // Gate names already shown as an entry icon are not repeated as a label.
    if (amenities.some((a) => a.label.toLowerCase() === text.toLowerCase() && near(a.position, position, 3))) continue;
    if (markers.some((m) => m.text === text && near(m.position, position, 5))) continue;
    markers.push({ text, position });
  }
  return markers;
}

/** Entries, exits and cargo gates on (or right by) the outline become doors in the hall wall. */
function findOpenings(amenities: ImportedAmenity[], boundary: Point[]): HallOpening[] {
  const openings: HallOpening[] = [];
  for (const a of amenities) {
    const kind = OPENING_KIND[a.kind];
    if (!kind) continue;
    let best: { distance: number; x: number; z: number; edge: number } | null = null;
    for (let i = 0; i < boundary.length; i++) {
      const p = boundary[i];
      const q = boundary[(i + 1) % boundary.length];
      const hit = segmentDistance(a.position.x, a.position.z, p.x, p.z, q.x, q.z);
      if (!best || hit.distance < best.distance) best = { distance: hit.distance, x: hit.x, z: hit.y, edge: i };
    }
    if (!best || best.distance > 6) continue;
    const p = boundary[best.edge];
    const q = boundary[(best.edge + 1) % boundary.length];
    const facing = inwardFacing(p, q, best, boundary);
    const position = { x: round(best.x), z: round(best.z) };
    if (openings.some((o) => near(o.position, position, 3))) continue;
    openings.push({
      id: `o-${openings.length + 1}`,
      label: a.label,
      kind,
      position,
      width: kind === 'EMERGENCY' ? 2 : 4,
      facing,
    });
  }
  return openings;
}

function inwardFacing(p: Point, q: Point, at: { x: number; z: number }, boundary: Point[]): OpeningFacing {
  const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
  let nx = -(q.z - p.z) / len;
  let nz = (q.x - p.x) / len;
  const ring = boundary.flatMap((b) => [b.x, b.z]);
  if (!pointInPolygon(at.x + nx * 0.5, at.z + nz * 0.5, ring)) {
    nx = -nx;
    nz = -nz;
  }
  if (Math.abs(nx) >= Math.abs(nz)) return nx > 0 ? 'EAST' : 'WEST';
  return nz > 0 ? 'SOUTH' : 'NORTH';
}

function findZones(
  d: CadDrawing,
  s: number,
  inside: (x: number, y: number) => boolean,
  plan: (x: number, y: number) => Point,
): HallZone[] {
  const zones: HallZone[] = [];
  const add = (kind: ZoneKind, label: string, color: string, polygon: Point[]) => {
    if (zones.length >= MAX_ZONES || !validPolygon(polygon.flatMap((p) => [p.x, p.z]))) return;
    zones.push({ id: `z-${zones.length + 1}`, kind, label, color, polygon });
  };

  for (const p of d.polylines) {
    const match = ZONE_LAYERS.find(([re]) => re.test(leaf(p.layer)));
    if (!match) continue;
    const [, kind, label, color] = match;
    if (p.closed && p.points.length >= 6) {
      const b = boxOf(p.points);
      if (!inside((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2) || polygonArea(p.points) * s * s < 1) continue;
      const ring = simplifyRing(cleanRing(p.points, 1e-4 / s), 0.05 / s);
      add(kind, label, color, ringToPlan(ring, plan));
      continue;
    }
    // A curtain or passage drawn as a line: a thin strip along each segment.
    for (let i = 0; i + 3 < p.points.length; i += 2) {
      const [x1, y1, x2, y2] = p.points.slice(i, i + 4);
      if (Math.hypot(x2 - x1, y2 - y1) * s < 1 || !inside((x1 + x2) / 2, (y1 + y2) / 2)) continue;
      add(kind, label, color, strip(plan(x1, y1), plan(x2, y2), kind === 'SMOKE_CURTAIN' ? 0.3 : 0.5));
    }
  }
  for (const f of d.fills) {
    const match = ZONE_LAYERS.find(([re]) => re.test(leaf(f.layer)));
    if (!match) continue;
    const [, kind, label, color] = match;
    for (const loop of f.loops) {
      const b = boxOf(loop);
      if (!inside((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2) || polygonArea(loop) * s * s < 1) continue;
      add(kind, label, color, ringToPlan(simplifyRing(cleanRing(loop, 1e-4 / s), 0.05 / s), plan));
    }
  }
  return zones;
}

function strip(a: Point, b: Point, half: number): Point[] {
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const nx = (-(b.z - a.z) / len) * half;
  const nz = ((b.x - a.x) / len) * half;
  return [
    { x: round(a.x + nx), z: round(a.z + nz) },
    { x: round(b.x + nx), z: round(b.z + nz) },
    { x: round(b.x - nx), z: round(b.z - nz) },
    { x: round(a.x - nx), z: round(a.z - nz) },
  ];
}

/** Structural columns inside the hall: drawn, but (as in SelfCare plans) not blocking. */
function findPillars(
  d: CadDrawing,
  s: number,
  inside: (x: number, y: number) => boolean,
  plan: (x: number, y: number) => Point,
): BlockedArea[] {
  const boxes: Box[] = [];
  for (const p of d.polylines) if (p.closed && COLUMN_LAYER.test(leaf(p.layer))) boxes.push(boxOf(p.points));
  for (const f of d.fills) if (COLUMN_LAYER.test(leaf(f.layer))) for (const loop of f.loops) boxes.push(boxOf(loop));

  const pillars: BlockedArea[] = [];
  for (const b of boxes) {
    const w = (b.maxX - b.minX) * s;
    const l = (b.maxY - b.minY) * s;
    if (w < 0.2 || l < 0.2 || w > 3.5 || l > 3.5) continue;
    const [x, y] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    if (!inside(x, y)) continue;
    const c = plan(x, y);
    if (pillars.some((p) => Math.abs(p.posX - c.x) < 0.3 && Math.abs(p.posZ - c.z) < 0.3)) continue;
    pillars.push({ posX: c.x, posZ: c.z, width: round(w), length: round(l), kind: 'zone', color: '#b0b4bd', title: 'Pillar' });
    if (pillars.length >= MAX_PILLARS) break;
  }
  return pillars;
}

function findCompass(
  d: CadDrawing,
  s: number,
  box: Box,
  margin: number,
  plan: (x: number, y: number) => Point,
): HallCompass | null {
  const arrow = d.inserts
    .filter((i) => NORTH_BLOCK.test(i.block.split(/\$0\$|\|/).pop()!))
    .sort((a, b) => Number(boxContains(box, b.x, b.y, margin * 3)) - Number(boxContains(box, a.x, a.y, margin * 3)))[0];
  if (!arrow) return null;
  const size = Math.min(12, Math.max(3, arrow.size * s || 5));
  return {
    position: plan(arrow.x, arrow.y),
    size: round(size),
    // CAD angles are counter-clockwise; the planner's are clockwise on the plan.
    rotation: round(((-arrow.rotation % 360) + 360) % 360),
    label: 'N',
    labelOffset: { x: -0.4, z: round(-size / 2 - 1.2) },
  };
}

/** Parts of a drawing a legend can be read from. */
interface LegendSource {
  texts: CadDrawing['texts'];
  fills: CadDrawing['fills'];
  polylines: CadDrawing['polylines'];
  hatchStrokes?: Record<string, number[]>;
}

/**
 * The plan's own legend: the rows under a "LEGEND" heading and the colour of the swatch left of
 * each. Rows are the texts inside the legend's frame when it has one, otherwise the run of rows
 * under the heading up to the first large gap. Swatches can be fills, thick lines or hatch;
 * the colour with the most ink left of the row wins, black and greys excluded.
 */
function findLegend(src: LegendSource, hallBox: Box | null): HallLegend[] {
  const cx = hallBox ? (hallBox.minX + hallBox.maxX) / 2 : 0;
  const cy = hallBox ? (hallBox.minY + hallBox.maxY) / 2 : 0;
  const heading = src.texts
    .filter((t) => /^legends?[\s:.…-]*$/i.test(t.text.trim()))
    .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
  if (!heading) return [];
  const h = heading.height || 1;

  const frame = src.polylines
    .filter((p) => p.closed && p.points.length >= 8 && p.points.length <= 40)
    .map((p) => boxOf(p.points))
    .filter((b) => boxContains(b, heading.x, heading.y) && b.maxX - b.minX < 90 * h && b.maxY - b.minY < 90 * h)
    .sort((a, b) => (a.maxX - a.minX) * (a.maxY - a.minY) - (b.maxX - b.minX) * (b.maxY - b.minY))
    .find((b) => src.texts.filter((t) => boxContains(b, t.x, t.y)).length >= 3);

  let rows = src.texts
    .filter((t) => t !== heading && t.text.length <= 70 && t.y < heading.y - 0.3 * h)
    .filter((t) =>
      frame ? boxContains(frame, t.x, t.y) : t.x >= heading.x - 6 * h && t.x <= heading.x + 90 * h && t.y >= heading.y - 70 * h,
    )
    .sort((a, b) => b.y - a.y);
  if (!frame) {
    // Without a frame, the legend ends at the first gap much larger than a row.
    const kept: typeof rows = [];
    let prevY = heading.y;
    for (const row of rows) {
      // The heading is often set larger than its rows, so its size counts towards the gap too.
      if (prevY - row.y > 3.2 * Math.max(row.height, h)) break;
      kept.push(row);
      prevY = row.y;
    }
    rows = kept;
  }

  const legends: HallLegend[] = [];
  for (const row of rows) {
    if (legends.length >= 25) break;
    const label = row.text.replace(/\s+/g, ' ').trim();
    if (!label || legends.some((l) => l.label === label)) continue;
    const color = swatchColor(src, row, frame ?? null);
    legends.push({ label, ...(color ? { colorCode: color } : {}), visibleInViewMode: true, visibleInBookMode: true });
  }
  return legends;
}

/**
 * The colour of a legend row's swatch. In a framed legend only ink inside the frame counts: the
 * plan often sits right beside the legend, and its walls and columns are not swatches. No
 * colour is better than a wrong one, which would paint wrong zones.
 */
export function swatchColor(src: LegendSource, row: CadDrawing['texts'][number], frame: Box | null): string | null {
  const h = row.height || 1;
  const left = row.x - 0.31 * h * row.text.length;
  const ink = new Map<string, number>();
  const add = (color: string | null, x: number, y: number, amount: number) => {
    if (!color || neutral(color)) return;
    if (frame && !boxContains(frame, x, y)) return;
    const dy = Math.abs(y - row.y);
    if (x > left + 0.8 * h || x < left - 14 * h || dy > 0.75 * h) return;
    // A swatch sits on its row's line; ink half a row away belongs to the neighbouring row.
    const weight = (1 - dy / (0.75 * h)) ** 2;
    ink.set(color, (ink.get(color) ?? 0) + amount * weight);
  };
  for (const f of src.fills) {
    const b = boxOf(f.loops.flat());
    if (b.maxX - b.minX > 12 * h) continue;
    add(f.color, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.maxX - b.minX) * (b.maxY - b.minY));
  }
  for (const p of src.polylines) {
    const b = boxOf(p.points);
    if (b.maxX - b.minX > 12 * h) continue;
    add(p.color, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (Math.hypot(b.maxX - b.minX, b.maxY - b.minY) + 0.15 * h) * h * 0.2);
  }
  for (const [color, segs] of Object.entries(src.hatchStrokes ?? {})) {
    for (let i = 0; i < segs.length; i += 4) {
      const [x1, y1, x2, y2] = [segs[i], segs[i + 1], segs[i + 2], segs[i + 3]];
      // Solid hatch can be exported as dots (zero-length strokes): each mark counts.
      add(color, (x1 + x2) / 2, (y1 + y2) / 2, (Math.hypot(x2 - x1, y2 - y1) + 0.15 * h) * h * 0.2);
    }
  }
  let best: string | null = null;
  let most = 0;
  for (const [color, amount] of ink) if (amount > most) [best, most] = [color, amount];
  return best;
}

/** Black, white and greys: text, frames and paper, never a legend colour. */
function neutral(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return Math.max(r, g, b) - Math.min(r, g, b) < 30;
}

function sameColor(a: string, b: string): boolean {
  const x = parseInt(a.slice(1), 16);
  const y = parseInt(b.slice(1), 16);
  return [16, 8, 0].every((shift) => Math.abs(((x >> shift) & 255) - ((y >> shift) & 255)) <= 24);
}

/** Legend rows that name a restriction, and the zone kind each one draws. */
const LEGEND_ZONES: Array<[RegExp, ZoneKind]> = [
  [/smoke\s*curtain/i, 'SMOKE_CURTAIN'],
  [/compulsory\s*passage|passage\s*for\s*exit|emergency\s*passage/i, 'PASSAGE'],
  [/peripheral|no[\s-]*construction|non[\s-]*construct/i, 'NO_CONSTRUCTION'],
  [/compulsory\s*access/i, 'FACILITY_ACCESS'],
];
/**
 * Layers that can carry zone paint: hatch, fills and zone layers. Walls, doors, partitions and
 * frames often share a zone's colour (green walls, red stall partitions) and are never zones.
 */
const ZONE_PAINT_LAYER = /hatch|fill|zone|passage|curtain|smoke|constr|restrict|access|^nc$|^layer\d*$|^0$|^$/i;
const NOT_ZONE_LAYER = /partition|facia|fascia|title|text|anno|dim|grid|stall|door|number|symb|hose|fhc|wall|glaz|col|stair|elev|flor|facade|panel/i;

/**
 * A floor under two or more hall titles is split between them. Each hall's own coded labels
 * ("TOILET 4G-A", "FOYER 4G") mark its side; the cut is the partition or smoke-curtain strip
 * (legend colours) that crosses the whole floor between two halls' labels, or else the midpoint
 * between them. Returns the floor unchanged when it holds one hall.
 */
function splitSharedFloor(d: CadDrawing, legends: HallLegend[], floor: number[], building: number[], s: number): number[][] {
  const fb = boxOf(floor);
  const near = 45 / s;
  const numberOf = (text: string) => HALL_NAME.exec(text)?.[1].replace(/\s/g, '').toUpperCase() ?? null;
  const titles = d.texts
    .filter((t) => /exhibition\s*hall/i.test(t.text) && numberOf(t.text))
    .filter((t) => boxContains(fb, t.x, t.y, 0) || (t.x >= fb.minX && t.x <= fb.maxX && t.y >= fb.minY - near && t.y <= fb.maxY + near));
  const halls = [...new Set(titles.map((t) => numberOf(t.text)!))];
  if (halls.length < 2) return [floor];

  // Split across the axis the titles are spread along.
  const spreadX = Math.max(...titles.map((t) => t.x)) - Math.min(...titles.map((t) => t.x));
  const spreadY = Math.max(...titles.map((t) => t.y)) - Math.min(...titles.map((t) => t.y));
  const alongX = spreadX >= spreadY;
  const a = (x: number, y: number) => (alongX ? x : y);

  // Where each hall's things are: its title and its coded labels (5G-A, FOYER 4G, H5G...).
  const marks = new Map<string, number[]>();
  for (const t of d.texts) {
    const coded = /(?:^|[^0-9A-Z])H?(\d{1,2}[A-Z]?)[GF](?:[-\s]|$)/i.exec(t.text)?.[1]?.toUpperCase();
    const n = /exhibition\s*hall/i.test(t.text) ? numberOf(t.text) : coded;
    if (!n || !halls.includes(n)) continue;
    if (!pointInPolygon(t.x, t.y, building) && !titles.includes(t)) continue;
    const list = marks.get(n) ?? [];
    list.push(a(t.x, t.y));
    marks.set(n, list);
  }
  const order = [...halls].sort((p, q) => median(marks.get(p) ?? [0]) - median(marks.get(q) ?? [0]));

  // Strips that cross the whole floor: partitions and smoke curtains, as the legend colours them.
  const strips: number[] = [];
  const colours = new Set(legends.filter((l) => l.colorCode && /partition|smoke\s*curtain/i.test(l.label)).map((l) => l.colorCode!));
  for (const colour of colours) {
    strips.push(...crossingStrips(paintSegments(d, colour), fb, s, { alongX, minCover: 0.6, maxWidthMetres: 3 }));
  }

  // Hall titles are centred under their halls, so the boundary between two neighbours lies
  // near the midpoint of their titles: the strip closest to it, else the midpoint itself.
  const titleAt = new Map<string, number>();
  for (const t of titles) titleAt.set(numberOf(t.text)!, a(t.x, t.y));
  const cuts: number[] = [];
  for (let i = 0; i + 1 < order.length; i++) {
    const p = titleAt.get(order[i]);
    const q = titleAt.get(order[i + 1]);
    if (p === undefined || q === undefined) continue;
    const mid = (p + q) / 2;
    const [from, to] = p < q ? [p, q] : [q, p];
    const between = strips.filter((x) => x > from && x < to).sort((u, v) => Math.abs(u - mid) - Math.abs(v - mid));
    cuts.push(between[0] ?? mid);
  }
  const bounds = [-Infinity, ...cuts.sort((p, q) => p - q), Infinity];
  const pieces: number[][] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const piece = clipBand(floor, bounds[i], bounds[i + 1], alongX);
    if (piece.length >= 6) pieces.push(piece);
  }
  return pieces.length >= 2 ? pieces : [floor];
}

function median(values: number[]): number {
  const sorted = [...values].sort((p, q) => p - q);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The part of a ring between two lines across `x` (or `y`): Sutherland-Hodgman, twice. */
function clipBand(ring: number[], from: number, to: number, alongX: boolean): number[] {
  const axis = alongX ? 0 : 1;
  const clip = (pts: number[], keep: (v: number) => boolean, at: number): number[] => {
    const out: number[] = [];
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const [px, py] = [pts[2 * i], pts[2 * i + 1]];
      const j = (i + 1) % n;
      const [qx, qy] = [pts[2 * j], pts[2 * j + 1]];
      const pv = axis === 0 ? px : py;
      const qv = axis === 0 ? qx : qy;
      if (keep(pv)) out.push(px, py);
      if (keep(pv) !== keep(qv)) {
        const t = (at - pv) / (qv - pv);
        out.push(px + (qx - px) * t, py + (qy - py) * t);
      }
    }
    return out;
  };
  let pts = ring;
  if (Number.isFinite(from)) pts = clip(pts, (v) => v >= from, from);
  if (Number.isFinite(to) && pts.length >= 6) pts = clip(pts, (v) => v <= to, to);
  return pts;
}

/** Every stroke painted in a legend colour: hatch, and lines on layers that carry zone paint. */
function paintSegments(d: CadDrawing, color: string): number[] {
  const segments: number[] = [];
  for (const [c, segs] of Object.entries(d.hatchStrokes ?? {})) {
    // No spread: a hatch colour can hold millions of numbers, beyond the argument limit.
    if (sameColor(c, color)) for (let i = 0; i < segs.length; i++) segments.push(segs[i]);
  }
  for (const p of d.polylines) {
    const layer = leaf(p.layer);
    if (!p.color || !sameColor(p.color, color) || NOT_ZONE_LAYER.test(layer) || !ZONE_PAINT_LAYER.test(layer)) continue;
    const n = p.points.length;
    const last = p.closed ? n : n - 2;
    for (let i = 0; i < last; i += 2) {
      const j = (i + 2) % n;
      segments.push(p.points[i], p.points[i + 1], p.points[j], p.points[j + 1]);
    }
  }
  return segments;
}

/**
 * Zones exactly as the plan paints them: for each legend row that names a restriction, every
 * area inside the hall painted in that row's colour (hatch, thick lines or fills) becomes a zone
 * of the row's kind, labelled with the row's text.
 */
function legendZones(
  d: CadDrawing,
  legends: HallLegend[],
  s: number,
  hallBox: Box,
  inside: (x: number, y: number) => boolean,
  plan: (x: number, y: number) => Point,
): HallZone[] {
  const zones: HallZone[] = [];
  const pad = 2 / s;
  const box = { minX: hallBox.minX - pad, minY: hallBox.minY - pad, maxX: hallBox.maxX + pad, maxY: hallBox.maxY + pad };
  for (const legend of legends) {
    const color = legend.colorCode;
    const kind = LEGEND_ZONES.find(([re]) => re.test(legend.label))?.[1];
    if (!color || !kind) continue;
    const segments = paintSegments(d, color);
    const rings: number[][] = [];
    const small = kind === 'FACILITY_ACCESS';
    for (const r of coveredRegions(segments, box, s, { closeMetres: 0.6, minArea: small ? 0.5 : 2, minThickness: small ? 0.3 : 0.4 })) rings.push(r.ring);
    for (const f of d.fills) {
      const layer = leaf(f.layer);
      if (!f.color || !sameColor(f.color, color) || NOT_ZONE_LAYER.test(layer) || !ZONE_PAINT_LAYER.test(layer)) continue;
      for (const loop of f.loops) if (polygonArea(loop) * s * s >= (small ? 0.5 : 2)) rings.push(loop);
    }
    const label = legend.label.length > 60 ? legend.label.slice(0, 57) + '…' : legend.label;
    let count = 0;
    for (const ring of rings) {
      if (count >= 80) break;
      const b = boxOf(ring);
      if (!inside((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2)) continue;
      const simplified = simplifyRing(cleanRing(ring, 1e-4 / s), 0.2 / s);
      const polygon = ringToPlan(simplified, plan);
      if (!validPolygon(polygon.flatMap((p) => [p.x, p.z]))) continue;
      zones.push({ id: `z-${kind.toLowerCase()}-${++count}`, kind, label, color, polygon });
    }
  }
  return zones;
}

function linework(
  d: CadDrawing,
  s: number,
  box: Box,
  margin: number,
  plan: (x: number, y: number) => Point,
  maxSegments = MAX_LINEWORK_SEGMENTS,
): number[] {
  const tiers: number[][] = LINEWORK_PRIORITY.map(() => []);
  const rest: number[] = [];
  const minLength = 0.05 / s;
  for (const p of d.polylines) {
    if (LINEWORK_SKIP.test(leaf(p.layer))) continue;
    const b = boxOf(p.points);
    if (b.maxX < box.minX - margin || b.minX > box.maxX + margin || b.maxY < box.minY - margin || b.minY > box.maxY + margin) continue;
    const tier = LINEWORK_PRIORITY.findIndex((re) => re.test(leaf(p.layer)));
    const out = tier >= 0 ? tiers[tier] : rest;
    const n = p.points.length;
    const last = p.closed ? n : n - 2;
    for (let i = 0; i < last; i += 2) {
      const j = (i + 2) % n;
      const [x1, y1, x2, y2] = [p.points[i], p.points[i + 1], p.points[j], p.points[j + 1]];
      if (Math.hypot(x2 - x1, y2 - y1) < minLength) continue;
      const a = plan(x1, y1);
      const c = plan(x2, y2);
      out.push(round2(a.x), round2(a.z), round2(c.x), round2(c.z));
    }
  }
  const all: number[] = [];
  for (const segs of [...tiers, rest]) {
    const room = maxSegments * 4 - all.length;
    if (room <= 0) break;
    all.push(...segs.slice(0, room));
  }
  return all;
}

// --- small helpers -------------------------------------------------------------------------

/** The planner's own polygon check, so an outline or zone offered here always saves. */
function validPolygon(flat: number[]): boolean {
  const points: Point[] = [];
  for (let i = 0; i < flat.length; i += 2) points.push({ x: flat[i], z: flat[i + 1] });
  try {
    validateHallGeometry({ boundary: points });
    return true;
  } catch {
    return false;
  }
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(\d+[a-z])\b/gi, (m) => m.toUpperCase());
}

function near(a: Point, b: Point, distance: number): boolean {
  return Math.hypot(a.x - b.x, a.z - b.z) < distance;
}

/** The layer's own name, without the xref drawing it came from ("hall_A6$0$A-WALL" -> "A-WALL"). */
function leaf(layer: string): string {
  return layer.split(/\$0\$|\|/).pop()!;
}

function shortLayer(layer: string): string {
  return layer.split(/\$0\$|\|/).pop()!.slice(0, 40);
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
