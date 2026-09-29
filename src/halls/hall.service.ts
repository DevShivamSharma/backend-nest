import { Injectable } from '@nestjs/common';

import { BadRequestDomainError } from '../common/errors/domain.errors';
import type { HallDto } from '../layouts/dto/layout-save-request.dto';
import type { HallResponse } from '../layouts/dto/layout-response.dto';
import { HallEntity } from '../layouts/entities/hall.entity';
import type { BlockedArea } from '../layouts/entities/hall.entity';
import type { HallWrite } from '../layouts/layout.repository';
import { normalizeShape } from '../layouts/layout.validator';
import { hallGeometryResponse, validateHallGeometry } from '../layouts/placement/hall-geometry';
import { HallRepository } from './hall.repository';
import { validateHallRequest } from './hall.validator';

/**
 * /api/halls — port of HallController.java (ADR-002: ported, marked deprecated).
 *
 * The Java controller talked to the repository directly and skipped the service layer
 * entirely. Here the same five operations go through a service so they share the layout path's
 * validation (ADR-015) and so the controller stays thin, like `LayoutController`.
 *
 * @deprecated Neither frontend calls these endpoints (02-api-inventory.md section 7-10). They
 * exist because "no frontend consumer" is not "no consumer" and this project has no git history
 * to prove otherwise (ADR-002). Remove once the author confirms nothing else calls them.
 */
@Injectable()
export class HallService {
  constructor(private readonly hallRepository: HallRepository) {}

  /**
   * Every hall, as in the Java.
   *
   * `standaloneOnly` is an addition: it returns only halls no layout owns, which is what the
   * planner's hall picker needs. The default is the Java behaviour, so the ported contract is
   * unchanged for any unknown caller (ADR-002).
   */
  async list(standaloneOnly = false): Promise<HallResponse[]> {
    const halls = standaloneOnly
      ? await this.hallRepository.findStandalone()
      : await this.hallRepository.findAll();

    return halls.map(toHallResponse);
  }

  async get(id: number): Promise<HallResponse> {
    const hall = await this.hallRepository.findById(id);
    if (hall === null) throw notFound(id);

    return toHallResponse(hall);
  }

  async create(request: HallDto): Promise<HallResponse> {
    validateHallRequest(request);

    const hall = await this.hallRepository.create(copyHall(request));

    return toHallResponse(hall);
  }

  async update(id: number, request: HallDto): Promise<HallResponse> {
    validateHallRequest(request);

    const hall = await this.hallRepository.update(id, copyHall(request));
    if (hall === null) throw notFound(id);

    return toHallResponse(hall);
  }

  async delete(id: number): Promise<void> {
    // A saved layout's own hall copy goes with its layout; deleting it alone would break it.
    const layout = await this.hallRepository.owningLayoutName(id);
    if (layout !== null) {
      throw new BadRequestDomainError(
        `This hall belongs to the saved layout "${layout}". Delete that layout instead.`,
      );
    }
    const deleted = await this.hallRepository.delete(id);
    if (!deleted) throw notFound(id);
  }
}

/**
 * The Java message, verbatim (HallController.java:41, :77, :103).
 *
 * 400, not 404 — the Java's `IllegalArgumentException` reached `GlobalExceptionHandler` as a bad
 * request and that is preserved deliberately (ADR-003).
 */
function notFound(id: number): BadRequestDomainError {
  return new BadRequestDomainError(`Hall not found: ${id}`);
}

/**
 * The five writable columns. Any `id` in the body is dropped: the Java called
 * `hall.setId(null)` before saving (HallController.java:58), and BR-18 already says ids sent by
 * clients are ignored on every write path.
 */
function copyHall(request: HallDto): HallWrite {
  return {
    name: request.name ?? null,
    shape: normalizeShape(request.shape),
    width: request.width ?? null,
    length: request.length ?? null,
    radius: request.radius ?? null,
    blockedAreas: (request.blockedAreas as BlockedArea[] | null | undefined) ?? null,
    ...validateHallGeometry(request),
  };
}

/** Same shape Jackson produced from the Hall entity (02-api-inventory.md section 0). */
function toHallResponse(hall: HallEntity): HallResponse {
  return {
    id: hall.id,
    name: hall.name,
    shape: hall.shape,
    width: hall.width,
    length: hall.length,
    radius: hall.radius,
    blockedAreas: hall.blockedAreas ?? null,
    ...hallGeometryResponse(hall),
  };
}
