import { BadRequestDomainError, PlacementRejectedError } from '../common/errors/domain.errors';
import { isRepresentableFootprint } from './placement/polygon-geometry';
import { normalizeFootprint, normalizeOpenEdges } from './placement/stall-footprint';
import type { HallDto, LayoutSaveRequestDto } from './dto/layout-save-request.dto';
import { HallShape } from './layout.geometry';
import {
  normalizeEventType,
  normalizeStatus,
  validateHallGeometry,
} from './placement/hall-geometry';

/**
 * Business validation — a line-for-line port of LayoutService.validate()
 * (LayoutService.java:409-560). Pure: no framework, no ORM.
 *
 * TWO THINGS HERE ARE CONTRACT, because both frontends display `message` verbatim:
 *   1. the message strings, character for character;
 *   2. the ORDER of the checks — the first failure wins. Notably the hall SHAPE is checked
 *      before the hall NAME (LayoutService.java:427 precedes :434).
 * That is why these rules are hand-ordered code and not class-validator decorators (ADR-010).
 */

const GATE_SIDES: ReadonlySet<string> = new Set(['FRONT', 'BACK', 'LEFT', 'RIGHT']);

/** The Java `n(Double)` helper: null -> 0 (LayoutService.java:716-723). */
export function n(value: number | null | undefined): number {
  return value ?? 0;
}

/** Java `String.isBlank()` on a nullable string. */
export function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim().length === 0;
}

/** BR-03. LayoutService.shape() (LayoutService.java:663-681). */
export function normalizeShape(value: string | null | undefined): HallShape {
  const shape = value == null ? '' : value.trim().toUpperCase();

  if (shape !== 'SQUARE' && shape !== 'CIRCLE') {
    throw new BadRequestDomainError('Hall shape must be SQUARE or CIRCLE.');
  }

  return shape;
}

/** BR-12. LayoutService.gate() (LayoutService.java:687-710). Blank defaults to FRONT. */
export function normalizeGate(value: string | null | undefined): string {
  const gate = isBlank(value) ? 'FRONT' : (value as string).trim().toUpperCase();

  if (!GATE_SIDES.has(gate)) {
    throw new BadRequestDomainError('gateSide must be FRONT, BACK, LEFT or RIGHT.');
  }

  return gate;
}

/**
 * Validates raw openSides entries (throws on the first invalid one). Checked
 * right after BR-12; the normalized list is built later, when copying.
 */
export function validateOpenSides(raw: unknown[] | null | undefined): void {
  for (const entry of raw ?? []) {
    const side = typeof entry === 'string' ? entry.trim().toUpperCase() : '';

    if (!GATE_SIDES.has(side)) {
      throw new BadRequestDomainError('openSides entries must be FRONT, BACK, LEFT or RIGHT.');
    }
  }
}

/**
 * Builds the deduped, validated open-sides list for one stall. An absent or
 * empty list falls back to the single gate side, so the result is never empty.
 */
export function normalizeOpenSidesList(
  raw: unknown[] | null | undefined,
  gateFallback: string,
): string[] {
  validateOpenSides(raw);

  const sides: string[] = [];
  for (const entry of (raw ?? []) as string[]) {
    const side = entry.trim().toUpperCase();
    if (!sides.includes(side)) sides.push(side);
  }

  return sides.length ? sides : [gateFallback];
}

export function validateLayoutRequest(
  request: LayoutSaveRequestDto | null | undefined,
): asserts request is LayoutSaveRequestDto & { hall: HallDto } {
  // BR-01
  if (request == null) {
    throw new BadRequestDomainError('Request body is required.');
  }

  // BR-02
  if (request.hall == null) {
    throw new BadRequestDomainError('Hall data is required.');
  }

  const hall = request.hall;

  // BR-03 — before the name check, exactly as in the Java.
  const shape = normalizeShape(hall.shape);

  // BR-04
  if (isBlank(hall.name)) {
    throw new BadRequestDomainError('Hall name is required.');
  }

  if (shape === 'SQUARE') {
    // BR-05
    if (n(hall.width) <= 0 || n(hall.length) <= 0) {
      throw new BadRequestDomainError('Hall width and length must be greater than 0.');
    }
  } else if (n(hall.radius) <= 0) {
    // BR-06
    throw new BadRequestDomainError('Hall radius must be greater than 0.');
  }

  // BR-07 — no stalls is a valid layout.
  const stalls = request.stalls ?? [];

  for (let i = 0; i < stalls.length; i++) {
    const stall = stalls[i];

    // BR-08
    if (stall == null) {
      throw new BadRequestDomainError(`Stall at index ${i} is null.`);
    }

    // Java primitives: a JSON null becomes 0.0, which BR-10 then rejects.
    const footprint = {
      width: n(stall.width),
      length: n(stall.length),
      posX: n(stall.posX),
      posZ: n(stall.posZ),
    };
    const height = n(stall.height);

    // BR-09
    if (
      !Number.isFinite(footprint.width) ||
      !Number.isFinite(footprint.length) ||
      !Number.isFinite(height) ||
      !Number.isFinite(stall.rotation ?? 0) ||
      !Number.isFinite(footprint.posX) ||
      !Number.isFinite(footprint.posZ)
    ) {
      throw new BadRequestDomainError(`Invalid numeric value in stall at index ${i}.`);
    }

    // BR-10
    if (footprint.width <= 0 || footprint.length <= 0 || height <= 0) {
      throw new BadRequestDomainError(`Invalid stall dimensions at index ${i}.`);
    }
    // Custom (polygon) stall: the outline must be a valid simple polygon, its open edges real
    // edges of it. Its bounding box replaces width/length when copied (layout.service).
    let outline: Pick<import('./placement/placement-rules').Footprint, 'footprint'> = {};
    if (stall.footprint != null) {
      const normalized = normalizeFootprint(stall.footprint);
      if (typeof normalized === 'string') {
        throw new BadRequestDomainError(`Stall at index ${i}: ${normalized}`);
      }
      const edges = normalizeOpenEdges(stall.openEdges, normalized.points.length);
      if (typeof edges === 'string') throw new BadRequestDomainError(`Stall at index ${i}: ${edges}`);
      outline = { footprint: normalized.points };
      footprint.width = normalized.width;
      footprint.length = normalized.length;
    } else if (stall.openEdges != null) {
      throw new BadRequestDomainError(`Stall at index ${i}: openEdges needs a footprint.`);
    }
    if (!isRepresentableFootprint({ ...footprint, ...outline, rotation: stall.rotation ?? 0 })) {
      throw new PlacementRejectedError(
        `Stall ${i} geometry cannot be represented at metre precision.`,
        [
          {
            code: 'INVALID_DIMENSIONS',
            stallIndex: i,
            stallNumber: stall.stallNumber ?? null,
            message: 'Dimensions and position must form finite, non-degenerate edges.',
            relatedStallIds: [],
            geometry: [],
          },
        ],
      );
    }

    // BR-12 — called only for its exception; the value is used later, when copying.
    normalizeGate(stall.gateSide);

    // openSides entries — checked right after BR-12; the list is built when copying.
    validateOpenSides(stall.openSides);

    // BR-23 — status value.
    normalizeStatus(stall.status);
  }

  // BR-22 — rule-driven hall geometry, checked last so every older message keeps its place.
  validateHallGeometry(hall);
  normalizeEventType(request.eventType);
}
