import type { PlanTextKind } from '../../ai/plan-texts';
import type { AnalysedText, SheetAnalysis } from '../../integrations/drawings/drawing-analysis';
import { FLOOR, GroupChoice, mapAreas, OUTSIDE } from '../../integrations/drawings/grid-map';
import {
  blocksStalls,
  FLOOR_SCHEMA,
  FloorAreaKind,
  FloorIconGroup,
  FloorLabel,
  FloorLegendEntry,
  FloorRect,
  FloorZone,
  HallFloor,
} from '../floor/hall-floor';
import type { DetectedHall } from './detect-halls';
import type { SheetParts } from './sheet-parts';

/**
 * One detected hall as a `floor/1` floor in its own coordinates (metres, top-left of its
 * extent), plus the figures the review and the checks need. Bands keep their drawn geometry;
 * how much more floor a whole-cell stall grid would lose around them is reported, not baked in.
 */

/** Map value for an enclosed gap in the hall's floor (a void, stairwell or shaft). */
export const HOLE = -3;

/** A text of the sheet as the review decided it. */
export interface ReviewedText {
  index: number;
  text: string;
  kind: PlanTextKind;
  /** Not yet confirmed: never placed on the floor. */
  review: boolean;
  by: string;
}

export interface BandStats {
  groupId: number;
  kind: FloorAreaKind | 'floor';
  color: string;
  /** Drawn area, m². */
  area: number;
  /** Extra floor a whole-cell stall grid loses around the band, m² (null without a grid). */
  cellMaskExtra: number | null;
}

export interface HallStats {
  width: number;
  depth: number;
  /** The hall's own floor (not its foyer), bands included, m². */
  gross: number;
  /** Gross less areas that block stalls and voids, m². */
  stallFloor: number;
  foyer: number;
  foyerStallFloor: number;
  voids: number;
  bands: BandStats[];
}

export interface BuiltHall {
  floor: HallFloor;
  stats: HallStats;
  /** The hall's (0, 0) on the sheet's map, in map units. */
  offset: { x: number; y: number };
  /** The hall's extent on the sheet, map units. */
  box: { x: number; y: number; width: number; height: number };
}

/** Labels and icons this far outside the hall still belong to it (metres): exit codes. */
const TEXT_MARGIN = 8;
/** Icons closer than this form one group, as on ITPO's plans (metres). */
const ICON_GROUP_DISTANCE = 3;

export function buildHall(input: {
  fileName: string;
  sheet: SheetAnalysis;
  parts: SheetParts;
  hall: DetectedHall;
  metresPerUnit: number;
  scaleSource: string;
  groupChoices: ReadonlyMap<number, GroupChoice>;
  holeChoice: GroupChoice;
  texts: ReviewedText[];
}): BuiltHall {
  const { sheet, parts, hall, metresPerUnit: mpu } = input;
  const { cols, sub } = parts;
  const res = mpu / sub;
  const roleOf = new Map(hall.parts.map((p) => [p.id, p.role]));

  // The hall's extent on the map.
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
  for (const p of hall.parts) {
    const part = parts.parts[p.id];
    if (!part) continue;
    x0 = Math.min(x0, part.x0);
    y0 = Math.min(y0, part.y0);
    x1 = Math.max(x1, part.x1);
    y1 = Math.max(y1, part.y1);
  }
  const w = Math.max(0, x1 - x0 + 1);
  const h = Math.max(0, y1 - y0 + 1);
  const cells = new Int16Array(w * h).fill(OUTSIDE);
  const zoneOf = new Uint8Array(w * h); // 0 hall floor, 1 foyer, 2 circulation
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y + y0) * cols + (x + x0);
      const role = roleOf.get(parts.partOf[k]);
      if (!role) continue;
      cells[y * w + x] = parts.cells[k];
      zoneOf[y * w + x] = role === 'foyer' ? 1 : role === 'circulation' ? 2 : 0;
    }
  }

  // Enclosed gaps: outside cells the hall's floor surrounds.
  const reached = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (k: number) => {
    if (!reached[k] && cells[k] === OUTSIDE) {
      reached[k] = 1;
      stack.push(k);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % w;
    if (x > 0) seed(k - 1);
    if (x < w - 1) seed(k + 1);
    if (k >= w) seed(k - w);
    if (k < (h - 1) * w) seed(k + w);
  }
  for (let k = 0; k < cells.length; k++) if (cells[k] === OUTSIDE && !reached[k]) cells[k] = HOLE;

  const choices = new Map(input.groupChoices);
  choices.set(HOLE, input.holeChoice);
  const areas = mapAreas({ cols: w, rows: h, cells, groups: sheet.map.groups }, choices, res);
  for (const a of areas) {
    if (a.kind === 'void' && !a.color) a.color = '#d9d9d9';
  }

  // Zones: the foyer and circulation pieces, as rectangles.
  const zones: FloorZone[] = [];
  for (const [code, kind] of [
    [1, 'foyer'],
    [2, 'circulation'],
  ] as const) {
    const rects = mergeRects(w, h, (k) => zoneOf[k] === code && cells[k] !== OUTSIDE, res);
    if (rects.length) zones.push({ kind, rects });
  }

  // Figures.
  const kindOf = (v: number): FloorAreaKind | 'floor' => {
    if (v === FLOOR) return 'floor';
    if (v === HOLE) return input.holeChoice;
    if (v < 0) return 'outside';
    return choices.get(v) ?? sheet.map.groups.find((g) => g.id === v)?.kind ?? 'unavailable';
  };
  const cellArea = res * res;
  let gross = 0;
  let stallFloor = 0;
  let foyer = 0;
  let foyerStallFloor = 0;
  let voids = 0;
  const bandCells = new Map<number, number>();
  const bandUnits = new Map<number, Set<number>>();
  for (let k = 0; k < cells.length; k++) {
    const v = cells[k];
    if (v === OUTSIDE) continue;
    const kind = kindOf(v);
    // A colour the person called "outside the hall" is not the hall's floor.
    if (kind === 'outside') continue;
    if (v === HOLE) {
      if (kind === 'void') {
        voids += cellArea;
        continue;
      }
    }
    const open = kind === 'floor' || !blocksStalls(kind);
    if (zoneOf[k] === 1) {
      foyer += cellArea;
      if (open) foyerStallFloor += cellArea;
    } else {
      gross += cellArea;
      if (open) stallFloor += cellArea;
    }
    if (v >= 0) {
      bandCells.set(v, (bandCells.get(v) ?? 0) + 1);
      if (!open && sheet.map.source === 'grid') {
        const unit =
          Math.floor(((k % w) + x0) / sub) * 1_000_000 + Math.floor((Math.floor(k / w) + y0) / sub);
        let set = bandUnits.get(v);
        if (!set) bandUnits.set(v, (set = new Set()));
        set.add(unit);
      }
    }
  }
  const bands: BandStats[] = [...bandCells].map(([id, n]) => {
    const group = sheet.map.groups.find((g) => g.id === id);
    const area = n * cellArea;
    const units = bandUnits.get(id);
    return {
      groupId: id,
      kind: kindOf(id),
      color: group?.color ?? '#888888',
      area: r2(area),
      cellMaskExtra: units ? r2(Math.max(0, units.size * mpu * mpu - area)) : null,
    };
  });

  // Texts: labels and icons on or near this hall; legend rows wherever they are on the sheet.
  const width = r3(w * res);
  const depth = r3(h * res);
  const ox = x0 / sub;
  const oy = y0 / sub;
  const toHall = (t: AnalysedText) => ({ x: r3((t.x - ox) * mpu), y: r3((t.y - oy) * mpu) });
  const near = (p: { x: number; y: number }) =>
    p.x >= -TEXT_MARGIN &&
    p.y >= -TEXT_MARGIN &&
    p.x <= width + TEXT_MARGIN &&
    p.y <= depth + TEXT_MARGIN;
  const labels: FloorLabel[] = [];
  const iconPoints: Array<{ x: number; y: number; kind: string; label: string }> = [];
  const legend: FloorLegendEntry[] = [];
  for (const t of input.texts) {
    if (t.review) continue;
    const at = sheet.texts[t.index];
    if (!at) continue;
    const p = toHall(at);
    if (t.kind === 'label' && near(p)) {
      labels.push({ text: t.text.slice(0, 120), ...p });
    } else if (t.kind.startsWith('icon:') && near(p)) {
      iconPoints.push({ ...p, kind: t.kind.slice(5), label: t.text.slice(0, 80) });
    } else if (t.kind.startsWith('area:')) {
      // A legend row has a colour swatch beside it, or is a whole phrase; a lone word is a
      // symbol's caption.
      if (!at.swatch && t.by !== 'you' && t.text.trim().split(/\s+/).length < 3) continue;
      if (legend.some((l) => l.label === t.text)) continue;
      legend.push({
        label: t.text.slice(0, 200),
        kind: t.kind.slice(5) as FloorAreaKind,
        ...(at.swatch ? { color: at.swatch.color } : {}),
        showInView: true,
      });
    }
  }
  for (const z of zones) z.name = z.kind === 'foyer' ? 'Foyer' : 'Circulation';

  const floor: HallFloor = {
    schema: FLOOR_SCHEMA,
    width,
    depth,
    areas,
    labels,
    iconGroups: groupIcons(iconPoints),
    north: null,
    legend,
    ...(zones.length ? { zones } : {}),
    placement: {
      file: input.fileName.slice(0, 160),
      page: sheet.page,
      x: r3(ox * mpu),
      y: r3(oy * mpu),
      rotation: sheet.rotation,
      gridMetres: sheet.map.source === 'grid' ? r3(mpu) : null,
      scaleSource: input.scaleSource.slice(0, 300),
    },
  };
  return {
    floor,
    stats: {
      width,
      depth,
      gross: r2(gross),
      stallFloor: r2(stallFloor),
      foyer: r2(foyer),
      foyerStallFloor: r2(foyerStallFloor),
      voids: r2(voids),
      bands,
    },
    offset: { x: ox, y: oy },
    box: { x: ox, y: oy, width: w / sub, height: h / sub },
  };
}

/** Rectangles covering the cells `take` accepts: equal runs on consecutive rows merged. */
export function mergeRects(
  cols: number,
  rows: number,
  take: (k: number) => boolean,
  res: number,
): FloorRect[] {
  const out: FloorRect[] = [];
  let open = new Map<string, { x0: number; x1: number; y0: number }>();
  for (let y = 0; y <= rows; y++) {
    const next = new Map<string, { x0: number; x1: number; y0: number }>();
    if (y < rows) {
      let x = 0;
      while (x < cols) {
        if (!take(y * cols + x)) {
          x++;
          continue;
        }
        let end = x + 1;
        while (end < cols && take(y * cols + end)) end++;
        const key = `${x}:${end}`;
        next.set(key, open.get(key) ?? { x0: x, x1: end, y0: y });
        open.delete(key);
        x = end;
      }
    }
    for (const o of open.values()) {
      out.push({
        x: r3(o.x0 * res),
        y: r3(o.y0 * res),
        width: r3((o.x1 - o.x0) * res),
        height: r3((y - o.y0) * res),
      });
    }
    open = next;
  }
  return out;
}

/** Icons close together become one group, placed at the first one. */
function groupIcons(
  points: Array<{ x: number; y: number; kind: string; label: string }>,
): FloorIconGroup[] {
  const groups: FloorIconGroup[] = [];
  for (const p of points) {
    const group = groups.find(
      (g) => Math.hypot(g.x - p.x, g.y - p.y) <= ICON_GROUP_DISTANCE && g.icons.length < 6,
    );
    const icon = { kind: p.kind, label: p.label };
    if (group) {
      if (!group.icons.some((i) => i.kind === icon.kind)) group.icons.push(icon);
    } else {
      groups.push({ x: p.x, y: p.y, icons: [icon] });
    }
  }
  return groups;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
