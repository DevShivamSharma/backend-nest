import { difference, type MultiPolygon } from 'polygon-clipping';
import { area, contained, distance, EPS, overlaps, ring, stallPolygon } from './polygon-geometry';
import { ruleEnabled } from './basic-rules';
import type { EventType, Footprint, PlacementContext, Point, Violation } from './placement-rules';

export const PLANNING_ZONE_KINDS = ['MEDIA', 'ADMIN', 'FOOD', 'EXHIBITION'] as const;
export type PlanningZoneKind = typeof PLANNING_ZONE_KINDS[number];
export interface PlanningZone {
  id: string;
  kind: PlanningZoneKind;
  label: string;
  polygon: Point[];
  eventType: EventType;
  color?: string;
}
export const sellableZone = (zone: PlanningZone) => zone.kind === 'FOOD' || zone.kind === 'EXHIBITION';
export function planningZoneFor(stall: Footprint, zones: readonly PlanningZone[]): PlanningZone | undefined {
  const footprint = stallPolygon(stall);
  return zones.find(zone => sellableZone(zone) && contained(footprint, [ring(zone.polygon)]));
}
export function usableFloor(ctx: PlacementContext): MultiPolygon {
  const boundary = ctx.circleRadius == null ? ctx.boundary : Array.from({ length: 128 }, (_, i) => ({
    x: ctx.circleRadius! * Math.cos(i * Math.PI / 64), z: ctx.circleRadius! * Math.sin(i * Math.PI / 64),
  }));
  let floor: MultiPolygon = boundary?.length ? [ring(boundary)] : [];
  for (const obstacle of ctx.obstacles ?? []) if (floor.length) floor = difference(floor, ring(obstacle));
  return floor;
}
export function footprintArea(stall: Footprint): number {
  return area([ring(stallPolygon(stall))]);
}
export function utilization(ctx: PlacementContext) {
  let floorArea = area(usableFloor(ctx));
  if (ctx.circleRadius != null) {
    const circle = { ...ctx, obstacles: [] };
    floorArea += Math.PI * ctx.circleRadius ** 2 - area(usableFloor(circle));
  }
  const usedArea = ctx.stalls.filter(s => s.status !== 'CANCELLED').reduce((sum, s) => sum + footprintArea(s), 0);
  const limit = Math.min(0.7, ctx.rules.maxUtilization ?? 0.7);
  const ratio = floorArea > EPS ? usedArea / floorArea : usedArea > 0 ? 1 : 0;
  return { floorArea, usedArea, ratio, limit, exceeded: usedArea > floorArea * limit + EPS };
}
/** Zones may touch, but cannot overlap or extend beyond the usable hall floor. */
export function planningZoneGeometryError(zones: readonly PlanningZone[], ctx: PlacementContext): string | null {
  const floor = usableFloor(ctx);
  for (const [i, zone] of zones.entries()) {
    const inside = ctx.circleRadius == null ? contained(zone.polygon, floor) :
      zone.polygon.every(p => Math.hypot(p.x, p.z) <= ctx.circleRadius! + EPS) &&
      !(ctx.obstacles ?? []).some(o => overlaps(zone.polygon, o));
    if (!inside) return `${zone.label} must stay inside the usable hall floor.`;
    if (zones.slice(0, i).some(other => overlaps(zone.polygon, other.polygon)))
      return `${zone.label} overlaps another planning zone. Zones may touch but cannot overlap.`;
  }
  return null;
}
export function planningZoneViolations(candidate: Footprint, ctx: PlacementContext, ignoreId: string | null): Violation[] {
  const zones = ctx.planningZones ?? [];
  if (!zones.length) return [];
  const footprint = stallPolygon(candidate);
  const home = planningZoneFor(candidate, zones);
  const violations: Violation[] = [];
  const add = (code: Violation['code'], message: string, ids: string[] = []) => violations.push({
    code, message, ruleRef: 'Planning zones', geometry: [{ type: 'polygon', points: footprint }], relatedStallIds: ids,
  });
  if (ruleEnabled(ctx.rules, 'internalZones')) {
    const internal = zones.find(z => !sellableZone(z) && overlaps(footprint, z.polygon));
    if (internal) add('INTERNAL_ZONE', `${internal.label} is an internal ${internal.kind.toLowerCase()} zone and cannot contain stalls.`);
    else if (!home) add('ZONE_BOUNDARY', 'Place the whole stall inside one Food or Exhibition zone.');
  }
  if (home && ruleEnabled(ctx.rules, 'eventSeparation')) {
    const separation = Math.max(3, ctx.rules.eventSeparation ?? 3);
    const bounds = (points: Point[]) => ({ minX: Math.min(...points.map(p=>p.x)), maxX: Math.max(...points.map(p=>p.x)), minZ: Math.min(...points.map(p=>p.z)), maxZ: Math.max(...points.map(p=>p.z)) });
    const a = bounds(footprint);
    for (const other of ctx.stalls) {
      if (other.status === 'CANCELLED' || String(other.id) === ignoreId) continue;
      const polygon = stallPolygon(other), b = bounds(polygon);
      // Bounding-box distance is a lower bound even for rotated/custom polygons. Most pairs
      // are far apart; avoid repeated polygon containment work for those pairs.
      if (Math.hypot(Math.max(a.minX-b.maxX,b.minX-a.maxX,0),Math.max(a.minZ-b.maxZ,b.minZ-a.maxZ,0)) >= separation-EPS) continue;
      if (distance(footprint, polygon) >= separation-EPS) continue;
      const otherZone = planningZoneFor(other, zones);
      if (otherZone && otherZone.eventType !== home.eventType)
        add('EVENT_SEPARATION', `Keep ${separation} m between B2B and B2C stalls.`, [String(other.id)]);
    }
  }
  return violations;
}
