import { DrawingProfile } from '../rules/drawing-profiles';
import {
  EventType,
  RuleId,
  ruleOn,
  RuleSwitches,
  RuleValues,
  RULES,
} from '../rules/rule-catalogue';
import { checkLayout, PlanStall, ruleFloor, StallSide } from '../rules/rule-engine';
import {
  area,
  bounds,
  difference,
  inside,
  intersection,
  rectangle,
} from '../venues/floor-plan/geometry';
import type { MultiPolygon, Point } from '../venues/floor-plan/plan.types';
import { blocksStalls, FloorAreaKind, FloorRect, HallFloor } from '../venues/floor/hall-floor';

/**
 * Checks a whole plan of an event hall: its stalls with the rules engine, and its seats and
 * zones with the same rules as they apply to them. Pure, like the engine.
 *
 * Seats can be thousands, so they get a check of their own: what they may not stand on is
 * found by bounding box first, and only those few shapes are clipped against each seat.
 */

export interface PlanSeatRect {
  id: string;
  /** e.g. C-10 */
  label: string;
  x: number;
  y: number;
  width: number;
  depth: number;
}

export interface PlanZoneShape {
  id: string;
  name: string;
  polygon: Point[];
}

/** One broken rule: what it says, and the zones, stalls or seats it is about. */
export interface PlanFinding {
  ruleId: string;
  message: string;
  ids: string[];
}

export interface PlanCheckInput {
  floor: HallFloor;
  switches: RuleSwitches;
  values: RuleValues;
  eventType: EventType;
  profile: DrawingProfile | null;
  stalls: PlanStall[];
  seats: PlanSeatRect[];
  zones: PlanZoneShape[];
}

const EPS = 1e-6;
const AREA_EPS = 1e-4;

const OFF_FLOOR: ReadonlySet<FloorAreaKind> = new Set([
  'outside',
  'wall',
  'void',
  'facility',
  'unavailable',
]);

const KIND_TEXT: Partial<Record<FloorAreaKind, string>> = {
  outside: 'ground outside the hall',
  wall: 'a wall',
  void: 'a void in the floor',
  facility: 'a room or facility',
  unavailable: 'floor not available for exhibitions',
  column: 'a pillar',
  passage: 'a compulsory passage',
  no_build: 'a no-construction zone',
  entry: 'an entry or exit area',
  fire_curtain: 'the area below a fire curtain',
  utility: 'a service point',
};

/** Which rule stops a seat standing on an area of this kind, and the clearance it keeps. */
const SEAT_RULE: Partial<Record<FloorAreaKind, { rule: RuleId; clearance?: keyof RuleValues }>> = {
  outside: { rule: 'hallBoundary' },
  wall: { rule: 'hallBoundary' },
  void: { rule: 'hallBoundary' },
  facility: { rule: 'hallBoundary' },
  unavailable: { rule: 'hallBoundary' },
  column: { rule: 'hallBoundary' },
  passage: { rule: 'PASSAGE' },
  no_build: { rule: 'NO_CONSTRUCTION' },
  entry: { rule: 'ENTRY_EXIT_ACCESS' },
  fire_curtain: { rule: 'SMOKE_CURTAIN', clearance: 'curtainClearance' },
  utility: { rule: 'FACILITY_ACCESS', clearance: 'facilityClearance' },
};

export function checkPlan(input: PlanCheckInput): PlanFinding[] {
  const { switches, values } = input;
  const on = (id: RuleId) =>
    ruleOn(switches, id) && (RULES.find((r) => r.id === id)?.available ?? false);
  const out: PlanFinding[] = [];

  const report = checkLayout({
    floor: input.floor,
    stalls: input.stalls,
    switches,
    values,
    eventType: input.eventType,
    profile: input.profile,
  });
  for (const v of report.violations) {
    out.push({ ruleId: v.ruleId, message: v.message, ids: v.stallIds });
  }

  const floor = ruleFloor(input.floor);

  // Zones: a part of the hall, so on its floor.
  if (on('hallBoundary')) {
    for (const z of input.zones) {
      const shape: MultiPolygon = [[closed(z.polygon)]];
      if (area(difference(shape, floor.floor)) > 0.01) {
        out.push({
          ruleId: 'hallBoundary',
          message: `Zone ${z.name} reaches past the hall's floor.`,
          ids: [z.id],
        });
      }
    }
  }

  if (!input.seats.length) return out;

  // What seats may not stand on, with a box to find it fast.
  const obstacles = floor.objects
    .filter((o) => OFF_FLOOR.has(o.kind) || blocksStalls(o.kind) || o.kind === 'column')
    .map((o) => {
      const rule = SEAT_RULE[o.kind];
      const clearance = rule?.clearance ? (values[rule.clearance] as number) : 0;
      return { ...o, rule, clearance, box: grow(bounds(o.geometry), clearance) };
    })
    .filter((o) => o.rule && on(o.rule.rule));
  const foyers =
    on('FOYER') && !values.foyerConstruction && floor.foyers.length
      ? { geometry: floor.foyers, box: bounds(floor.foyers) }
      : null;
  const exitClearance = values.emergencyExitClearance;
  const exits = on('EMERGENCY_EXIT_ACCESS')
    ? floor.exits.map(([x, y]) => ({
        x: x - exitClearance,
        y: y - exitClearance,
        width: 2 * exitClearance,
        height: 2 * exitClearance,
      }))
    : [];
  const floorVertices = floor.floor.flat(2);

  const stallIndex = new BoxIndex(
    input.stalls.map((s) => ({ id: s.id, label: stallText(s), box: rectOf(s) })),
  );
  const seatIndex = new BoxIndex(
    input.seats.map((s) => ({ id: s.id, label: `Seat ${s.label}`, box: rectOf(s) })),
  );

  for (const s of input.seats) {
    const r = rectOf(s);
    const poly = rectangle(r.x, r.y, r.width, r.height);
    const label = `Seat ${s.label}`;

    if (on('hallBoundary') && !onFloor(r, floor.floor, floorVertices)) {
      out.push({
        ruleId: 'hallBoundary',
        message: `${label} is off the hall's floor.`,
        ids: [s.id],
      });
      continue;
    }
    let blocked = false;
    for (const o of obstacles) {
      if (!overlap(r, o.box)) continue;
      const hit = area(intersection(poly, o.geometry)) > AREA_EPS;
      const near = !hit && o.clearance > 0;
      if (hit || near) {
        const what = KIND_TEXT[o.kind] ?? 'a blocked area';
        const named = o.label ? `${what} (${o.label})` : what;
        out.push({
          ruleId: o.rule!.rule,
          message: hit
            ? `${label} stands on ${named}.`
            : `${label} is too close to ${named}; keep ${fmt(o.clearance)} m clear.`,
          ids: [s.id],
        });
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    if (foyers && overlap(r, foyers.box) && area(intersection(poly, foyers.geometry)) > AREA_EPS) {
      out.push({ ruleId: 'FOYER', message: `${label} stands in the foyer.`, ids: [s.id] });
      continue;
    }
    if (exits.some((e) => overlap(r, e))) {
      out.push({
        ruleId: 'EMERGENCY_EXIT_ACCESS',
        message: `${label} is within ${fmt(exitClearance)} m of an emergency exit.`,
        ids: [s.id],
      });
      continue;
    }
    if (on('stallOverlap')) {
      const stall = stallIndex.hits(r)[0];
      if (stall) {
        out.push({
          ruleId: 'stallOverlap',
          message: `${label} overlaps ${stall.label}.`,
          ids: [s.id, stall.id],
        });
        continue;
      }
      const other = seatIndex.hits(r).find((o) => o.id !== s.id && o.id > s.id);
      if (other) {
        out.push({
          ruleId: 'stallOverlap',
          message: `${label} overlaps ${other.label}.`,
          ids: [s.id, other.id],
        });
      }
    }
  }

  // Seats in front of a stall's open side block the way in.
  if (on('openSideAccess')) {
    const passage = values.passageWidth[input.eventType];
    for (const s of input.stalls) {
      for (const side of s.openSides) {
        const front = frontOf(rectOf(s), side, passage);
        const seats = seatIndex.hits(front);
        if (seats.length) {
          out.push({
            ruleId: 'openSideAccess',
            message: `The ${side} open side of ${stallText(s)} needs ${fmt(passage)} m clear; ${seats[0].label}${seats.length > 1 ? ` and ${seats.length - 1} more seats` : ''} stand there.`,
            ids: [s.id, ...seats.map((x) => x.id)],
          });
        }
      }
    }
  }
  return out;
}

/** The findings that are about one of these ids, or about the whole plan. */
export function findingsFor(findings: PlanFinding[], ids: ReadonlySet<string>): PlanFinding[] {
  return findings.filter((f) => !f.ids.length || f.ids.some((id) => ids.has(id)));
}

// ---- geometry -------------------------------------------------------------------------------

function rectOf(s: { x: number; y: number; width: number; depth: number }): FloorRect {
  return { x: s.x, y: s.y, width: s.width, height: s.depth };
}

function stallText(s: PlanStall): string {
  return s.number ? `Stall ${s.number}` : 'a stall';
}

function closed(ring: Point[]): Point[] {
  const [a, b] = [ring[0], ring[ring.length - 1]];
  return a[0] === b[0] && a[1] === b[1] ? ring : [...ring, a];
}

function overlap(a: FloorRect, b: FloorRect): boolean {
  return (
    a.x < b.x + b.width - EPS &&
    b.x < a.x + a.width - EPS &&
    a.y < b.y + b.height - EPS &&
    b.y < a.y + a.height - EPS
  );
}

function grow(a: FloorRect, by: number): FloorRect {
  return { x: a.x - by, y: a.y - by, width: a.width + 2 * by, height: a.height + 2 * by };
}

/** A rectangle is on the floor when its corners are, and no corner of the floor is inside it. */
function onFloor(r: FloorRect, floor: MultiPolygon, vertices: Point[]): boolean {
  const corners: Point[] = [
    [r.x + EPS, r.y + EPS],
    [r.x + r.width - EPS, r.y + EPS],
    [r.x + r.width - EPS, r.y + r.height - EPS],
    [r.x + EPS, r.y + r.height - EPS],
  ];
  if (!corners.every((c) => inside(c, floor))) return false;
  return !vertices.some(
    ([x, y]) =>
      x > r.x + EPS && x < r.x + r.width - EPS && y > r.y + EPS && y < r.y + r.height - EPS,
  );
}

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

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Boxes in 5 m buckets, to find the few that overlap a box without trying them all. */
class BoxIndex {
  private static readonly CELL = 5;
  private readonly buckets = new Map<
    string,
    Array<{ id: string; label: string; box: FloorRect }>
  >();

  constructor(items: Array<{ id: string; label: string; box: FloorRect }>) {
    for (const item of items) {
      for (const key of BoxIndex.keys(item.box)) {
        const list = this.buckets.get(key) ?? [];
        list.push(item);
        this.buckets.set(key, list);
      }
    }
  }

  hits(box: FloorRect): Array<{ id: string; label: string }> {
    const seen = new Set<string>();
    const out: Array<{ id: string; label: string }> = [];
    for (const key of BoxIndex.keys(box)) {
      for (const item of this.buckets.get(key) ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (overlap(box, item.box)) out.push(item);
      }
    }
    return out;
  }

  private static keys(b: FloorRect): string[] {
    const c = BoxIndex.CELL;
    const keys: string[] = [];
    for (let i = Math.floor(b.x / c); i <= Math.floor((b.x + b.width) / c); i++) {
      for (let j = Math.floor(b.y / c); j <= Math.floor((b.y + b.height) / c); j++) {
        keys.push(`${i}:${j}`);
      }
    }
    return keys;
  }
}
