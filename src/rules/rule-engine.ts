import { area, difference, intersection, rectangle, union } from '../venues/floor-plan/geometry';
import type { MultiPolygon, Point } from '../venues/floor-plan/plan.types';
import { blocksStalls, FloorAreaKind, FloorRect, HallFloor } from '../venues/floor/hall-floor';
import { DrawingProfile, profileViolations } from './drawing-profiles';
import { EventType, RULES, RuleId, ruleOn, RuleSwitches, RuleValues } from './rule-catalogue';

/**
 * Checks stalls on a hall's floor against an organisation's rules. Pure: no framework, no database. It is
 * the authority; a planner may preview the same checks, but saving and publishing go through
 * here.
 *
 * Units are metres in the floor's own coordinates (top-left origin, y down). The floor may be a
 * reviewed import (`geometry`: polygons with holes, objects, foyers) or an older floor of
 * rectangles (`areas`); both are read into one shape first, so every rule means the same on
 * both. Stalls are rectangles along the floor's axes; a turned stall is reported by the drawing
 * profile, not checked here.
 */

export type StallSide = 'top' | 'bottom' | 'left' | 'right';
export const STALL_SIDES: readonly StallSide[] = ['top', 'bottom', 'left', 'right'];

export interface PlanStall {
  id: string;
  number?: string | null;
  x: number;
  y: number;
  width: number;
  depth: number;
  openSides: StallSide[];
  /** Degrees; anything but 0 is turned. */
  rotation?: number;
}

/** A rule set aside for some stalls (or all), with the reason, as approval will show it. */
export interface RuleOverride {
  ruleId: RuleId;
  /** null: every stall. */
  stallIds: string[] | null;
  reason: string;
  by?: string | null;
}

export interface Violation {
  ruleId: RuleId | `profile.${string}`;
  reference: string;
  message: string;
  stallIds: string[];
  /** Where to draw it, floor metres. */
  areas: FloorRect[];
  /** Set aside by an override: listed, but not blocking. */
  overridden: { reason: string; by: string | null } | null;
}

export interface RuleState {
  id: RuleId;
  state: 'checked' | 'off' | 'unavailable';
  violations: number;
  overridden: number;
}

export interface RuleReport {
  /** True when nothing blocks: every violation is overridden. */
  passed: boolean;
  violations: Violation[];
  rules: RuleState[];
  /** Stall area over the hall's stall floor, 0 to 1. */
  utilisation: number;
}

export interface CheckInput {
  floor: HallFloor;
  stalls: PlanStall[];
  switches: RuleSwitches;
  values: RuleValues;
  eventType: EventType;
  overrides?: RuleOverride[];
  profile?: DrawingProfile | null;
}

const EPS = 1e-6;
/** Overlaps smaller than this (m²) are rounding, not a stall on an area. */
const AREA_EPS = 1e-4;
/** Raster used for free distances to walls (corners), metres per cell. */
const CELL = 0.25;

/** Floor kinds that are not the hall's floor at all. */
const OFF_FLOOR: ReadonlySet<FloorAreaKind> = new Set([
  'outside',
  'wall',
  'void',
  'facility',
  'unavailable',
]);

const RESTRICTED: Array<{
  kind: FloorAreaKind;
  rule: RuleId;
  text: string;
  clearance?: keyof RuleValues;
}> = [
  { kind: 'passage', rule: 'PASSAGE', text: 'a compulsory passage' },
  { kind: 'no_build', rule: 'NO_CONSTRUCTION', text: 'a no-construction zone' },
  { kind: 'entry', rule: 'ENTRY_EXIT_ACCESS', text: 'an entry or exit area' },
  {
    kind: 'fire_curtain',
    rule: 'SMOKE_CURTAIN',
    text: 'the area below a fire curtain',
    clearance: 'curtainClearance',
  },
  {
    kind: 'utility',
    rule: 'FACILITY_ACCESS',
    text: 'a service point',
    clearance: 'facilityClearance',
  },
];

const REFERENCE = new Map(RULES.map((r) => [r.id, r.reference]));

/** A floor as the rules see it. */
export interface RuleFloor {
  width: number;
  depth: number;
  /** Where the hall's floor is (stalls may stand), before restrictions. */
  floor: MultiPolygon;
  /** Areas on or off the floor, with their kind. */
  objects: Array<{ kind: FloorAreaKind; label: string; geometry: MultiPolygon }>;
  foyers: MultiPolygon;
  exits: Point[];
}

/** Reads either kind of floor into the one shape the rules use. */
export function ruleFloor(f: HallFloor): RuleFloor {
  const exits: Point[] = f.iconGroups
    .filter((g) => g.icons.some((i) => i.kind === 'emergency-exit'))
    .map((g) => [g.x, g.y]);
  if (f.geometry) {
    const g = f.geometry;
    return {
      width: f.width,
      depth: f.depth,
      floor: g.boundary,
      objects: g.objects.map((o) => ({ kind: o.kind, label: o.label, geometry: o.geometry })),
      foyers: union(...g.zones.filter((z) => z.kind === 'foyer').map((z) => z.geometry)),
      exits,
    };
  }
  // An older floor is its extent; what is off the floor comes as areas, read as objects.
  return {
    width: f.width,
    depth: f.depth,
    floor: rectangle(0, 0, f.width, f.depth),
    objects: f.areas.map((a) => ({
      kind: a.kind,
      label: a.label ?? '',
      geometry: rectangle(a.x, a.y, a.width, a.height),
    })),
    foyers: union(
      ...(f.zones ?? [])
        .filter((z) => z.kind === 'foyer')
        .flatMap((z) => z.rects.map((r) => rectangle(r.x, r.y, r.width, r.height))),
    ),
    exits,
  };
}

export function checkLayout(input: CheckInput): RuleReport {
  const { stalls, switches, values } = input;
  const floor = ruleFloor(input.floor);
  const on = (id: RuleId) =>
    ruleOn(switches, id) && (RULES.find((r) => r.id === id)?.available ?? false);
  const out: Violation[] = [];
  const add = (ruleId: RuleId, message: string, stallIds: string[], areas: FloorRect[]) =>
    out.push({
      ruleId,
      reference: REFERENCE.get(ruleId) ?? '',
      message,
      stallIds,
      areas,
      overridden: null,
    });
  const passage = values.passageWidth[input.eventType];
  const offFloor = floor.objects.filter((o) => OFF_FLOOR.has(o.kind));
  const blocking = floor.objects.filter((o) => !OFF_FLOOR.has(o.kind) && blocksStalls(o.kind));
  /** Where stalls may stand at all: the floor less what is off it. */
  const standable = difference(floor.floor, ...offFloor.map((o) => o.geometry));
  const raster = wallRaster(floor, standable);
  // The outer walls: the outline of the floor less the outside and walls drawn on it.
  const edges = outerEdges(
    difference(
      floor.floor,
      ...offFloor.filter((o) => o.kind === 'outside' || o.kind === 'wall').map((o) => o.geometry),
    ),
  );

  for (const s of stalls) {
    const r = rectOf(s);
    const poly = rectangle(r.x, r.y, r.width, r.height);
    const label = stallLabel(s);

    if (
      on('sizeStep') &&
      !(multipleOf(s.width, values.sizeStep) && multipleOf(s.depth, values.sizeStep))
    ) {
      add(
        'sizeStep',
        `${label} is ${fmt(s.width)} × ${fmt(s.depth)} m; sizes go in steps of ${fmt(values.sizeStep)} m.`,
        [s.id],
        [r],
      );
    }

    if (on('hallBoundary')) {
      const outside = difference(poly, floor.floor);
      if (area(outside) > AREA_EPS) {
        add('hallBoundary', `${label} reaches past the hall's floor.`, [s.id], boxes(outside));
      }
      const hits = offFloor.filter((o) => area(intersection(poly, o.geometry)) > AREA_EPS);
      if (hits.length) {
        const what = [...new Set(hits.map((o) => kindText(o.kind)))].join(', ');
        add(
          'hallBoundary',
          `${label} stands on ${what}.`,
          [s.id],
          hits.flatMap((o) => boxes(intersection(poly, o.geometry))),
        );
      }
    }

    // One finding per stall and kind: standing on it (wherever it does), else too close to the
    // nearest piece of it. A band drawn as several pieces is still one band.
    for (const z of RESTRICTED) {
      if (!on(z.rule)) continue;
      const clearance = z.clearance ? (values[z.clearance] as number) : 0;
      const pieces = floor.objects.filter((o) => o.kind === z.kind);
      const hits = pieces
        .map((o) => ({ o, hit: intersection(poly, o.geometry) }))
        .filter((h) => area(h.hit) > AREA_EPS);
      if (hits.length) {
        const named = hits.find((h) => h.o.label)?.o.label;
        add(
          z.rule,
          `${label} stands on ${named ? `${z.text} (${named})` : z.text}.`,
          [s.id],
          hits.flatMap((h) => boxes(h.hit)),
        );
      } else if (clearance > 0 && pieces.length) {
        let nearest = Infinity;
        let near: (typeof pieces)[number] | null = null;
        for (const o of pieces) {
          const d = polygonRectDistance(o.geometry, r);
          if (d < nearest) [nearest, near] = [d, o];
        }
        if (near && nearest < clearance - EPS) {
          const what = near.label ? `${z.text} (${near.label})` : z.text;
          add(
            z.rule,
            `${label} is ${fmt(nearest)} m from ${what}; keep ${fmt(clearance)} m clear.`,
            [s.id],
            [grow(box(near.geometry), clearance)],
          );
        }
      }
    }

    if (on('FOYER') && !values.foyerConstruction && floor.foyers.length) {
      const hit = intersection(poly, floor.foyers);
      if (area(hit) > AREA_EPS) add('FOYER', `${label} stands in the foyer.`, [s.id], boxes(hit));
    }

    if (on('peripheralClearance') && values.peripheralClearance > 0) {
      const c = values.peripheralClearance;
      let nearest = Infinity;
      for (const [a, b] of edges) nearest = Math.min(nearest, segmentRectDistance(a, b, r));
      // A stall already past the floor is reported as such, not as too close to the wall.
      if (nearest < c - EPS && area(difference(poly, floor.floor)) <= AREA_EPS) {
        add(
          'peripheralClearance',
          `${label} is ${fmt(nearest)} m from an outer wall; keep ${fmt(c)} m clear.`,
          [s.id],
          [grow(r, c)],
        );
      }
    }

    if (on('openSideAccess')) {
      for (const side of s.openSides) {
        const access = frontOf(r, side, passage);
        const accessPoly = rectangle(access.x, access.y, access.width, access.height);
        const blockers = stalls.filter((o) => o.id !== s.id && overlap(access, rectOf(o)));
        const leavesFloor = area(difference(accessPoly, standable)) > AREA_EPS;
        // A compulsory passage or an entry in front of a stall is a passage: it does not block.
        const blockedBy = blocking.filter(
          (o) =>
            o.kind !== 'passage' &&
            o.kind !== 'entry' &&
            area(intersection(accessPoly, o.geometry)) > AREA_EPS,
        );
        if (blockers.length || leavesFloor || blockedBy.length) {
          const by = blockers.length
            ? ` by ${blockers.map(stallLabel).join(', ')}`
            : blockedBy.length
              ? ` by ${kindText(blockedBy[0].kind)}`
              : ' by the hall';
          add(
            'openSideAccess',
            `The ${side} open side of ${label} needs ${fmt(passage)} m clear; it is blocked${by}.`,
            [s.id, ...blockers.map((b) => b.id)],
            [access],
          );
        }
      }
    }

    if (on('EMERGENCY_EXIT_ACCESS')) {
      const c = values.emergencyExitClearance;
      for (const [x, y] of floor.exits) {
        const zone = { x: x - c, y: y - c, width: 2 * c, height: 2 * c };
        if (overlap(r, zone)) {
          add(
            'EMERGENCY_EXIT_ACCESS',
            `${label} is within ${fmt(c)} m of an emergency exit.`,
            [s.id],
            [intersectRect(r, zone)],
          );
        }
      }
    }

    if (on('cornerKeepOut')) {
      const d = raster.freeDistances(r);
      if (
        (d.left < passage - EPS || d.right < passage - EPS) &&
        (d.up < passage - EPS || d.down < passage - EPS)
      ) {
        add(
          'cornerKeepOut',
          `${label} closes a corner of the hall: keep ${fmt(passage)} m clear from at least one of the two walls.`,
          [s.id],
          [r],
        );
      }
    }
  }

  if (on('stallOverlap')) {
    const sorted = [...stalls].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length; i++) {
      const a = rectOf(sorted[i]);
      for (let j = i + 1; j < sorted.length; j++) {
        const b = rectOf(sorted[j]);
        if (b.x >= a.x + a.width - EPS) break;
        if (overlap(a, b)) {
          add(
            'stallOverlap',
            `${stallLabel(sorted[i])} overlaps ${stallLabel(sorted[j])}.`,
            [sorted[i].id, sorted[j].id],
            [intersectRect(a, b)],
          );
        }
      }
    }
  }

  const stallFloor = area(difference(standable, ...blocking.map((o) => o.geometry)));
  const used = stalls.reduce((n, s) => n + s.width * s.depth, 0);
  const utilisation = stallFloor > 0 ? used / stallFloor : 0;
  if (on('maxUtilization') && utilisation > values.maxUtilization + EPS) {
    add(
      'maxUtilization',
      `Stalls cover ${Math.round(utilisation * 100)}% of the stall floor; at most ${Math.round(values.maxUtilization * 100)}% is allowed.`,
      [],
      [],
    );
  }

  if (input.profile) out.push(...profileViolations(input.profile, stalls));

  // Overrides set violations aside, with their reason.
  for (const v of out) {
    const o = (input.overrides ?? []).find(
      (x) =>
        x.ruleId === v.ruleId &&
        (x.stallIds === null || v.stallIds.every((id) => x.stallIds!.includes(id))),
    );
    if (o) v.overridden = { reason: o.reason, by: o.by ?? null };
  }

  const rules: RuleState[] = RULES.map((r) => {
    const mine = out.filter((v) => v.ruleId === r.id);
    return {
      id: r.id,
      state: !r.available ? 'unavailable' : ruleOn(switches, r.id) ? 'checked' : 'off',
      violations: mine.filter((v) => !v.overridden).length,
      overridden: mine.filter((v) => v.overridden).length,
    };
  });
  return {
    passed: out.every((v) => v.overridden),
    violations: out,
    rules,
    utilisation: Math.round(utilisation * 1000) / 1000,
  };
}

// ---- geometry -------------------------------------------------------------------------------

function rectOf(s: PlanStall): FloorRect {
  return { x: s.x, y: s.y, width: s.width, height: s.depth };
}

/** Overlap with positive area: touching edges is not overlapping. */
function overlap(a: FloorRect, b: FloorRect): boolean {
  return (
    a.x < b.x + b.width - EPS &&
    b.x < a.x + a.width - EPS &&
    a.y < b.y + b.height - EPS &&
    b.y < a.y + a.height - EPS
  );
}

function intersectRect(a: FloorRect, b: FloorRect): FloorRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

function grow(a: FloorRect, by: number): FloorRect {
  return { x: a.x - by, y: a.y - by, width: a.width + 2 * by, height: a.height + 2 * by };
}

function box(g: MultiPolygon): FloorRect {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of g) {
    for (const [x, y] of poly[0] ?? []) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return Number.isFinite(x0)
    ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
    : { x: 0, y: 0, width: 0, height: 0 };
}

/** The bounding box of each piece: enough to draw where a problem is. */
function boxes(g: MultiPolygon): FloorRect[] {
  return g.map((poly) => box([poly])).filter((r) => r.width > EPS && r.height > EPS);
}

/** The floor's outer edges: the walls of its outlines, not of holes inside it. */
function outerEdges(g: MultiPolygon): Array<[Point, Point]> {
  const out: Array<[Point, Point]> = [];
  for (const poly of g) {
    const ring = poly[0] ?? [];
    for (let i = 0; i + 1 < ring.length; i++) out.push([ring[i], ring[i + 1]]);
  }
  return out;
}

function segmentRectDistance(a: Point, b: Point, r: FloorRect): number {
  if (segmentHitsRect(a, b, r)) return 0;
  const corners: Point[] = [
    [r.x, r.y],
    [r.x + r.width, r.y],
    [r.x + r.width, r.y + r.height],
    [r.x, r.y + r.height],
  ];
  let best = Infinity;
  for (const c of corners) best = Math.min(best, pointSegmentDistance(c, a, b));
  for (let i = 0; i < 4; i++) {
    const p = corners[i];
    const q = corners[(i + 1) % 4];
    best = Math.min(best, pointSegmentDistance(a, p, q), pointSegmentDistance(b, p, q));
  }
  return best;
}

/** Whether a segment passes through the inside of a rectangle (touching is not). */
function segmentHitsRect(a: Point, b: Point, r: FloorRect): boolean {
  const inside = (p: Point) =>
    p[0] > r.x + EPS &&
    p[0] < r.x + r.width - EPS &&
    p[1] > r.y + EPS &&
    p[1] < r.y + r.height - EPS;
  if (inside(a) || inside(b)) return true;
  // Liang–Barsky clip against the open rectangle.
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - r.x],
    [dx, r.x + r.width - a[0]],
    [-dy, a[1] - r.y],
    [dy, r.y + r.height - a[1]],
  ]) {
    if (Math.abs(p) < EPS) {
      if (q <= EPS) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1 - EPS) return false;
    }
  }
  return true;
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function polygonRectDistance(g: MultiPolygon, r: FloorRect): number {
  let best = Infinity;
  for (const poly of g) {
    for (const ring of poly) {
      for (let i = 0; i + 1 < ring.length; i++) {
        best = Math.min(best, segmentRectDistance(ring[i], ring[i + 1], r));
      }
    }
  }
  return best;
}

/** The strip in front of an open side. */
function frontOf(r: FloorRect, side: StallSide, depth: number): FloorRect {
  switch (side) {
    case 'top':
      return { x: r.x, y: r.y - depth, width: r.width, height: depth };
    case 'bottom':
      return { x: r.x, y: r.y + r.height, width: r.width, height: depth };
    case 'left':
      return { x: r.x - depth, y: r.y, width: depth, height: r.height };
    case 'right':
      return { x: r.x + r.width, y: r.y, width: depth, height: r.height };
  }
}

function multipleOf(v: number, step: number): boolean {
  if (!(v > 0)) return false;
  const k = v / step;
  return Math.abs(k - Math.round(k)) < 1e-6;
}

/**
 * Where stalls may stand, on a fine raster, to measure the free floor between a stall and the
 * walls in each direction (the corner rule). Off the raster counts as wall.
 */
function wallRaster(floor: RuleFloor, standable: MultiPolygon) {
  const w = Math.max(1, Math.ceil(floor.width / CELL));
  const h = Math.max(1, Math.ceil(floor.depth / CELL));
  const free = new Uint8Array(w * h);
  // Even-odd scanline fill of every ring, at cell centres.
  for (let y = 0; y < h; y++) {
    const cy = (y + 0.5) * CELL;
    const xs: number[] = [];
    for (const poly of standable) {
      for (const ring of poly) {
        for (let i = 0; i + 1 < ring.length; i++) {
          const [ax, ay] = ring[i];
          const [bx, by] = ring[i + 1];
          if (ay <= cy !== by <= cy) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
        }
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] / CELL - 0.5));
      const c1 = Math.min(w - 1, Math.floor(xs[k + 1] / CELL - 0.5));
      if (c0 <= c1) free.fill(1, y * w + c0, y * w + c1 + 1);
    }
  }
  const wall = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || !free[y * w + x];
  return {
    freeDistances(r: FloorRect) {
      const x0 = Math.floor(r.x / CELL + EPS);
      const x1 = Math.ceil((r.x + r.width) / CELL - EPS);
      const y0 = Math.floor(r.y / CELL + EPS);
      const y1 = Math.ceil((r.y + r.height) / CELL - EPS);
      const scan = (from: number, step: number, fixed: [number, number], vertical: boolean) => {
        let best = Infinity;
        for (let f = fixed[0]; f < fixed[1]; f++) {
          let n = 0;
          let p = from;
          while (n * CELL < 100) {
            if (vertical ? wall(f, p) : wall(p, f)) break;
            n++;
            p += step;
          }
          best = Math.min(best, n * CELL);
        }
        return best;
      };
      return {
        left: scan(x0 - 1, -1, [y0, y1], false),
        right: scan(x1, 1, [y0, y1], false),
        up: scan(y0 - 1, -1, [x0, x1], true),
        down: scan(y1, 1, [x0, x1], true),
      };
    },
  };
}

const KIND_TEXT: Partial<Record<FloorAreaKind, string>> = {
  outside: 'ground outside the hall',
  wall: 'a wall',
  void: 'a void in the floor',
  facility: 'a room or facility',
  unavailable: 'floor not available for exhibitions',
  no_build: 'a no-construction zone',
  fire_curtain: 'a fire curtain',
  utility: 'a service point',
};

function kindText(kind: FloorAreaKind): string {
  return KIND_TEXT[kind] ?? kind;
}

function stallLabel(s: PlanStall): string {
  return s.number ? `Stall ${s.number}` : 'A stall';
}

function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}
