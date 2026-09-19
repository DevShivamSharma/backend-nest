import { BadRequestDomainError } from '../common/errors/domain.errors';
import type { HallDto, LayoutSaveRequestDto, StallDto } from './dto/layout-save-request.dto';
import { formatJavaDouble } from './java-double';
import { HallShape, isInsideHall, stallsOverlap } from './layout.geometry';

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

/** LayoutService.safeName() (LayoutService.java:566-574). Note: NOT trimmed, as in the Java. */
function safeName(stall: StallDto): string {
  return isBlank(stall.name) ? 'Shop' : (stall.name as string);
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

  const bounds = {
    shape,
    width: n(hall.width),
    length: n(hall.length),
    radius: n(hall.radius),
  };

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
      !Number.isFinite(footprint.posX) ||
      !Number.isFinite(footprint.posZ)
    ) {
      throw new BadRequestDomainError(`Invalid numeric value in stall at index ${i}.`);
    }

    // BR-10
    if (footprint.width <= 0 || footprint.length <= 0 || height <= 0) {
      throw new BadRequestDomainError(`Invalid stall dimensions at index ${i}.`);
    }

    // BR-11
    if (!isInsideHall(bounds, footprint)) {
      throw new BadRequestDomainError(
        `Stall ${i} (${safeName(stall)}) is outside hall boundary. ` +
          `Center X=${formatJavaDouble(footprint.posX)}, Z=${formatJavaDouble(footprint.posZ)}`,
      );
    }

    // BR-12 — called only for its exception; the value is used later, when copying.
    normalizeGate(stall.gateSide);

    // BR-13 — against every EARLIER stall. Earlier ones are already known non-null and valid.
    for (let j = 0; j < i; j++) {
      const other = stalls[j] as StallDto;
      const otherFootprint = {
        width: n(other.width),
        length: n(other.length),
        posX: n(other.posX),
        posZ: n(other.posZ),
      };

      if (stallsOverlap(footprint, otherFootprint)) {
        throw new BadRequestDomainError(
          `Stall ${i} (${safeName(stall)}) overlaps stall ${j} (${safeName(other)}).`,
        );
      }
    }
  }
}
