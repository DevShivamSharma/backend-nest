import { BadRequestDomainError } from '../common/errors/domain.errors';
import type { HallDto } from '../layouts/dto/layout-save-request.dto';
import type { HallShape } from '../layouts/layout.geometry';
import { isBlank, n, normalizeShape } from '../layouts/layout.validator';

/**
 * Hall validation for /api/halls.
 *
 * ADR-015 — an INTENTIONAL divergence from the Java. `HallController` had no validation at all
 * (R-10): it could write `shape = "banana"`, `width = -5` or an all-null hall straight to the
 * database. These endpoints now apply the same hall rules the layout path already applies
 * (BR-03 … BR-06), so a request the Java would have accepted may now return 400.
 *
 * The rules are reused from `layouts/layout.validator.ts` rather than re-stated, so the two
 * paths cannot drift apart. The ORDER also matches the layout path: shape is checked before
 * name (LayoutService.java:427 precedes :434), and the message strings are the same contract
 * strings, character for character.
 */
export function validateHallRequest(
  request: HallDto | null | undefined,
): asserts request is HallDto {
  // BR-02 — the Java would have thrown a NullPointerException here (500).
  if (request == null) {
    throw new BadRequestDomainError('Hall data is required.');
  }

  // BR-03 — before the name check, exactly as on the layout path.
  const shape = normalizeShape(request.shape);

  // BR-04
  if (isBlank(request.name)) {
    throw new BadRequestDomainError('Hall name is required.');
  }

  if (shape === 'SQUARE') {
    // BR-05
    if (n(request.width) <= 0 || n(request.length) <= 0) {
      throw new BadRequestDomainError('Hall width and length must be greater than 0.');
    }
  } else if (n(request.radius) <= 0) {
    // BR-06
    throw new BadRequestDomainError('Hall radius must be greater than 0.');
  }
}

/** The normalized shape, for callers that need it after validation has passed. */
export function hallShapeOf(request: HallDto): HallShape {
  return normalizeShape(request.shape);
}
