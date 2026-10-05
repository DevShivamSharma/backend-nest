import type { Footprint, PlacementContext, Point } from './placement-rules';
import { edges, EPS, segmentDistance, stallPolygon } from './polygon-geometry';

/** Hall-wall corners only; pillars and circular-wall approximations are not corners. */
export function atHallCorner(stall: Footprint, ctx: PlacementContext): boolean {
  if (ctx.circleRadius != null) return false;
  const footprintEdges = edges(stallPolygon(stall));
  const passage = ctx.rules.minPassageWidth[ctx.eventType];
  const wallDistance = (a: Point, b: Point) =>
    Math.min(...footprintEdges.map(([p, q]) => segmentDistance(a, b, p, q)));

  return [ctx.boundary, ...(ctx.regions ?? [])].some((outline) => {
    if (!outline || outline.length < 3) return false;
    // Imports may repeat the closing vertex or split a straight wall into several segments.
    const unique = outline.filter((p, i) => {
      const previous = outline[(i + outline.length - 1) % outline.length];
      return Math.hypot(p.x - previous.x, p.z - previous.z) > EPS;
    });
    const corners = unique.filter((b, i) => {
      const a = unique[(i + unique.length - 1) % unique.length];
      const c = unique[(i + 1) % unique.length];
      const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
      return Math.abs(cross) > EPS * Math.hypot(b.x - a.x, b.z - a.z) *
        Math.hypot(c.x - b.x, c.z - b.z);
    });
    return corners.some((b, i) => {
      const a = corners[(i + corners.length - 1) % corners.length];
      const c = corners[(i + 1) % corners.length];
      // A full passage width is sufficient, including at the exact limit.
      return wallDistance(a, b) < passage - EPS && wallDistance(b, c) < passage - EPS;
    });
  });
}
