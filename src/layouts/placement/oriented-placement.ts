import { ruleEnabled } from './basic-rules';
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
  contained,
  corridor,
  distance,
  edges,
  EPS,
  isRepresentableFootprint,
  openEdgeList,
  overlaps,
  ring,
  stallPolygon,
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
  const onStep = (v: number) =>
    Math.abs(v / ctx.rules.snapStep - Math.round(v / ctx.rules.snapStep)) <= EPS;
  if (
    ctx.enforceGrid && ruleEnabled(ctx.rules, 'sizeStep') &&
    (candidate.footprint && candidate.footprint.length >= 3
      ? // A custom outline: every edge, not just the bounding box, sits on the snap step.
        !edges(candidate.footprint).every(([a, b]) => onStep(Math.hypot(b.x - a.x, b.z - a.z)))
      : ![candidate.width, candidate.length].every(onStep))
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
  if (ruleEnabled(ctx.rules, 'hallBoundary') && !inside(p)) add('OUTSIDE_HALL', 'Stall is outside the usable hall boundary.', p);

  const rings: Point[][] =
    ctx.circleRadius != null
      ? obstacles
      : floor.flatMap((poly) => poly.map((r) => r.slice(0, -1).map(([x, z]) => ({ x, z }))));
  const others = ctx.stalls.filter((s) => String(s.id) !== ignoreId && s.status !== 'CANCELLED');
  // Stalls may share walls or stand any distance apart on their closed sides: a pair only must
  // not overlap. The passage is required in front of open sides alone (checked below).
  for (const other of ruleEnabled(ctx.rules, 'stallOverlap') ? others : []) {
    if (overlaps(p, stallPolygon(other)))
      add('STALL_OVERLAP', `Overlaps stall ${other.stallNumber ?? other.id}.`, p, [
        String(other.id),
      ]);
  }
  for (const { index, label: side } of ruleEnabled(ctx.rules, 'openSideAccess') ? openEdgeList(candidate) : []) {
    const access = corridor(p, index, passage);
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
      ruleEnabled(ctx.rules, z.kind) && ['PARTITION', 'SMOKE_CURTAIN', 'NO_CONSTRUCTION', 'FACILITY_ACCESS'].includes(z.kind),
    )) {
      if (overlaps(access, zone.polygon))
        add('OPEN_SIDE_PASSAGE', `${side} passage intersects ${zone.label}.`, access, [], {
          side,
          requiredWidth: passage,
        });
    }
  }
  // The candidate must not stand in the passage in front of another stall's open side either.
  for (const other of ruleEnabled(ctx.rules, 'openSideAccess') ? others : [])
    for (const { index, label: side } of openEdgeList(other)) {
      const access = corridor(stallPolygon(other), index, passage);
      if (overlaps(p, access))
        add(
          'OPEN_SIDE_BLOCKED',
          `Blocks the ${side} open side of ${other.stallNumber ?? other.id}; keep ${passage} m clear.`,
          access,
          [String(other.id)],
          { side, requiredWidth: passage },
        );
    }
  const wallGap =
    ctx.circleRadius != null
      ? ctx.circleRadius - Math.max(...p.map((v) => Math.hypot(v.x, v.z)))
      : rings.length
        ? Math.min(...rings.map((r) => distance(p, r)))
        : Infinity;
  if (ruleEnabled(ctx.rules, 'peripheralClearance') && wallGap < ctx.rules.peripheralClearance - EPS)
    add(
      'PERIPHERAL_CLEARANCE',
      `Required ${ctx.rules.peripheralClearance} m peripheral clearance; ${wallGap} m available.`,
      p,
    );
  for (const zone of ctx.zones) {
    if (!ruleEnabled(ctx.rules, zone.kind)) continue;
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
