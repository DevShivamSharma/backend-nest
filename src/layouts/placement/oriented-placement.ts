import { difference, type MultiPolygon } from 'polygon-clipping';
import { openingAccessRect, zoneClearanceFor } from './placement-rules';
import type {
  Footprint,
  PlacementContext,
  Point,
  ValidationResult,
  Violation,
  ViolationCode,
} from './placement-rules';
import {
  backToBack,
  gapInsideFloor,
  contained,
  corridor,
  distance,
  edges,
  EPS,
  isRepresentableFootprint,
  openSides,
  overlaps,
  ring,
  segmentDistance,
  sideIndexes,
  stallPolygon,
  sub,
} from './polygon-geometry';

export function validateOrientedPlacement(
  candidate: Footprint,
  ctx: PlacementContext,
  ignoreId: string | null,
): ValidationResult {
  const violations: Violation[] = [];
  const passage = ctx.rules.minPassageWidth[ctx.eventType];
  const add = (
    code: ViolationCode,
    message: string,
    p: Point[],
    ids: string[] = [],
    details = {},
  ) =>
    violations.push({
      code,
      message,
      ruleRef: 'Placement',
      geometry: [{ type: 'polygon', points: p }],
      relatedStallIds: ids,
      ...details,
    });
  const p = stallPolygon(candidate);
  if (
    ![
      candidate.width,
      candidate.length,
      candidate.posX,
      candidate.posZ,
      candidate.rotation ?? 0,
    ].every(Number.isFinite) ||
    candidate.width <= 0 ||
    candidate.length <= 0 ||
    !isRepresentableFootprint(candidate)
  ) {
    add(
      'INVALID_DIMENSIONS',
      'Stall dimensions and position must form finite, non-degenerate edges at metre precision.',
      [],
    );
    return { valid: false, violations };
  }
  if (
    ctx.enforceGrid &&
    [candidate.width, candidate.length].some(
      (v) => Math.abs(v / ctx.rules.snapStep - Math.round(v / ctx.rules.snapStep)) > EPS,
    )
  ) {
    add('INVALID_DIMENSIONS', `Stall size must be a multiple of ${ctx.rules.snapStep} m.`, p);
  }
  const obstacles = ctx.obstacles ?? [];
  let floor: MultiPolygon = ctx.boundary ? [ring(ctx.boundary)] : [];
  for (const obstacle of obstacles) if (floor.length) floor = difference(floor, ring(obstacle));
  const inside = (poly: Point[]) =>
    (ctx.circleRadius != null
      ? poly.every((v) => Math.hypot(v.x, v.z) <= ctx.circleRadius! + EPS)
      : contained(poly, floor)) && obstacles.every((o) => !overlaps(poly, o));
  if (!inside(p)) add('OUTSIDE_HALL', 'Stall is outside the usable hall boundary.', p);

  // Corners come from actual usable floor rings, including cut-outs, never an AABB.
  const rings: Point[][] =
    ctx.circleRadius != null
      ? obstacles
      : floor.flatMap((poly) => poly.map((r) => r.slice(0, -1).map(([x, z]) => ({ x, z }))));
  const isCorner = (poly: Point[]) =>
    rings.some((r) =>
      r.some((v, i) => {
        const prev = r[(i + r.length - 1) % r.length],
          next = r[(i + 1) % r.length];
        const a = sub(v, prev),
          b = sub(next, v);
        if (Math.abs(a.x * b.z - a.z * b.x) <= EPS * Math.hypot(a.x, a.z) * Math.hypot(b.x, b.z))
          return false;
        const near = (x: Point, y: Point) =>
          Math.min(...edges(poly).map(([s, t]) => segmentDistance(x, y, s, t))) <= passage + EPS;
        return near(prev, v) && near(v, next);
      }),
    );
  const corner = isCorner(p);
  const physicalZones = ctx.zones.filter((z) =>
    ['PARTITION', 'SMOKE_CURTAIN', 'NO_CONSTRUCTION', 'FACILITY_ACCESS'].includes(z.kind),
  );
  let walkableFloor = floor;
  for (const zone of physicalZones)
    if (walkableFloor.length) walkableFloor = difference(walkableFloor, ring(zone.polygon));
  const others = ctx.stalls.filter((s) => String(s.id) !== ignoreId && s.status !== 'CANCELLED');
  const nearest = Math.min(...others.map((other) => distance(p, stallPolygon(other))));
  for (const other of others) {
    const q = stallPolygon(other),
      ids = [String(other.id)];
    if (overlaps(p, q)) {
      add('STALL_OVERLAP', `Overlaps stall ${other.stallNumber ?? other.id}.`, p, ids);
      continue;
    }
    const gap = distance(p, q);
    if (corner && gap > EPS && gap <= nearest + EPS && ctx.circleRadius == null) {
      if (!gapInsideFloor(p, q, walkableFloor))
        add(
          'CORNER_PASSAGE',
          'The gap to the nearest stall is not wholly usable passage; exterior space and physical barriers cannot supply clearance.',
          p,
          ids,
          { requiredWidth: passage, actualWidth: 0 },
        );
    }
    if (gap < passage - EPS) {
      const cornerPair = corner || isCorner(q);
      if (cornerPair || gap > EPS || !backToBack(candidate, other)) {
        add(
          cornerPair ? 'CORNER_PASSAGE' : gap <= EPS ? 'INVALID_BACK_TO_BACK' : 'PATHWAY_WIDTH',
          `Required ${passage} m clear passage; ${Math.round(gap * 1e6) / 1e6} m available next to ${other.stallNumber ?? other.id}.`,
          p,
          ids,
          { requiredWidth: passage, actualWidth: gap },
        );
      }
    }
  }
  for (const side of openSides(candidate)) {
    const access = corridor(p, sideIndexes[side], passage);
    if (!inside(access))
      add(
        'OPEN_SIDE_PASSAGE',
        `${side} requires ${passage} m of usable floor in front of its entire edge.`,
        access,
        [],
        { side, requiredWidth: passage },
      );
    for (const other of others)
      if (overlaps(access, stallPolygon(other))) {
        add(
          'OPEN_SIDE_BLOCKED',
          `${side} passage is blocked by ${other.stallNumber ?? other.id}.`,
          access,
          [String(other.id)],
          { side, requiredWidth: passage },
        );
      }
    // Passage zones are walkable; physical restricted zones are not usable passage.
    for (const zone of ctx.zones.filter((z) =>
      ['PARTITION', 'SMOKE_CURTAIN', 'NO_CONSTRUCTION', 'FACILITY_ACCESS'].includes(z.kind),
    )) {
      if (overlaps(access, zone.polygon))
        add('OPEN_SIDE_PASSAGE', `${side} passage intersects ${zone.label}.`, access, [], {
          side,
          requiredWidth: passage,
        });
    }
  }
  const wallGap =
    ctx.circleRadius != null
      ? ctx.circleRadius - Math.max(...p.map((v) => Math.hypot(v.x, v.z)))
      : rings.length
        ? Math.min(...rings.map((r) => distance(p, r)))
        : Infinity;
  if (wallGap < ctx.rules.peripheralClearance - EPS)
    add(
      'PERIPHERAL_CLEARANCE',
      `Required ${ctx.rules.peripheralClearance} m peripheral clearance; ${wallGap} m available.`,
      p,
    );
  for (const zone of ctx.zones) {
    if (
      overlaps(p, zone.polygon) ||
      distance(p, zone.polygon) < zoneClearanceFor(zone, ctx.rules) - EPS
    )
      add('RESTRICTED_ZONE', `Stall intersects or is too close to ${zone.label}.`, zone.polygon);
  }
  for (const opening of ctx.openings) {
    const r = openingAccessRect(opening, ctx.rules, ctx.eventType);
    if (!r) continue;
    const access = [
      { x: r.minX, z: r.minZ },
      { x: r.maxX, z: r.minZ },
      { x: r.maxX, z: r.maxZ },
      { x: r.minX, z: r.maxZ },
    ];
    if (overlaps(p, access))
      add(
        opening.kind === 'EMERGENCY' ? 'EMERGENCY_ACCESS' : 'ENTRY_EXIT_BLOCKED',
        `Stall blocks ${opening.label}.`,
        access,
      );
  }
  return { valid: violations.length === 0, violations };
}
