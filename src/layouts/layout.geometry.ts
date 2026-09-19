/**
 * Pure geometry. No framework, no ORM, no I/O.
 *
 * Ported from LayoutService.inside() (LayoutService.java:580-629) and
 * LayoutService.overlap() (LayoutService.java:635-657). Both frontends carry an identical copy
 * of these formulas so the 3D editor can reject a drag before a round trip; the three
 * implementations must agree, including the tolerance.
 *
 * Coordinate system: the hall centre is the origin. posX / posZ are the stall CENTRE. Stalls are
 * axis-aligned; the model has no rotation.
 */
export const EPSILON = 1e-8;

export type HallShape = 'SQUARE' | 'CIRCLE';

export interface HallBounds {
  shape: HallShape;
  width: number;
  length: number;
  radius: number;
}

export interface StallFootprint {
  width: number;
  length: number;
  posX: number;
  posZ: number;
}

/** BR-11. A stall flush against the wall is inside (the tolerance makes `<=` forgiving). */
export function isInsideHall(hall: HallBounds, stall: StallFootprint): boolean {
  if (hall.shape === 'CIRCLE') {
    // Conservative rectangle-in-circle: the half-diagonal circle around the stall centre must
    // fit. Stricter than checking the four corners; intentional in the Java, ported as-is.
    const farthestCorner = Math.hypot(stall.width / 2, stall.length / 2);

    return Math.hypot(stall.posX, stall.posZ) + farthestCorner <= hall.radius + EPSILON;
  }

  return (
    Math.abs(stall.posX) + stall.width / 2 <= hall.width / 2 + EPSILON &&
    Math.abs(stall.posZ) + stall.length / 2 <= hall.length / 2 + EPSILON
  );
}

/** BR-13. Strict `<` minus the tolerance: stalls sharing an edge do NOT overlap. */
export function stallsOverlap(a: StallFootprint, b: StallFootprint): boolean {
  return (
    Math.abs(a.posX - b.posX) < (a.width + b.width) / 2 - EPSILON &&
    Math.abs(a.posZ - b.posZ) < (a.length + b.length) / 2 - EPSILON
  );
}
