import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BadRequestDomainError } from '../common/errors/domain.errors';
import type { LimitsConfig } from '../config/configuration';
import type {
  HallResponse,
  LayoutDetailResponse,
  LayoutSummaryResponse,
  StallResponse,
} from './dto/layout-response.dto';
import type { HallDto, LayoutSaveRequestDto, StallDto } from './dto/layout-save-request.dto';
import type { HallEntity } from './entities/hall.entity';
import type { StallEntity } from './entities/stall.entity';
import {
  HallWrite,
  LayoutAggregate,
  LayoutRepository,
  LayoutWrite,
  StallWrite,
} from './layout.repository';
import {
  isBlank,
  n,
  normalizeGate,
  normalizeShape,
  validateLayoutRequest,
} from './layout.validator';

/**
 * Port of LayoutService.java. Orchestration and the write-side rules BR-14 … BR-21.
 * Validation (BR-01 … BR-13) lives in layout.validator.ts; SQL lives in LayoutRepository.
 */
@Injectable()
export class LayoutService {
  private readonly maxStalls: number;

  constructor(
    private readonly layouts: LayoutRepository,
    config: ConfigService,
  ) {
    this.maxStalls = config.getOrThrow<LimitsConfig>('limits').maxStallsPerLayout;
  }

  async save(request: LayoutSaveRequestDto): Promise<LayoutDetailResponse> {
    const write = this.validateAndBuild(request);
    const saved = await this.layouts.create(write);

    return toDetail(saved, 'Layout saved successfully.');
  }

  list(): Promise<LayoutSummaryResponse[]> {
    return this.layouts.listSummaries();
  }

  async get(id: number): Promise<LayoutDetailResponse> {
    const found = await this.layouts.findById(id);
    if (found === null) throw notFound(id);

    // The Java passes a literal null message on GET (LayoutService.java:129).
    return toDetail(found, null);
  }

  async update(id: number, request: LayoutSaveRequestDto): Promise<LayoutDetailResponse> {
    // Java order: validate the body FIRST, then look the layout up (LayoutService.java:148-155).
    // A bad body for a missing id therefore reports the validation error, not "not found".
    const write = this.validateAndBuild(request);

    const saved = await this.layouts.replace(id, write);
    if (saved === null) throw notFound(id);

    return toDetail(saved, 'Layout updated successfully.');
  }

  async delete(id: number): Promise<void> {
    const deleted = await this.layouts.delete(id);
    if (!deleted) throw notFound(id);
  }

  private validateAndBuild(request: LayoutSaveRequestDto): LayoutWrite {
    // Not a Java rule: closes the unbounded-request risk (R-07). Runs first because the overlap
    // check below is O(n^2).
    if (Array.isArray(request?.stalls) && request.stalls.length > this.maxStalls) {
      throw new BadRequestDomainError(
        `Too many stalls: ${request.stalls.length}. Maximum is ${this.maxStalls}.`,
      );
    }

    validateLayoutRequest(request);

    const hall = copyHall(request.hall);

    return {
      name: layoutName(request),
      hall,
      // BR-19: copied from the hall regardless of shape, so circular layouts store 0 / 0.
      hallWidth: n(hall.width),
      hallLength: n(hall.length),
      // BR-15: always the literal 0 (LayoutService.java:47,193).
      hallHeight: 0,
      stalls: copyStalls(request.stalls),
    };
  }
}

/** Not-found is HTTP 400 with this exact text, as in the Java (ADR-003). */
function notFound(id: number): BadRequestDomainError {
  return new BadRequestDomainError(`Layout not found: ${id}`);
}

/** BR-14. LayoutService.name(): the layout name, else the hall name — trimmed either way. */
function layoutName(request: LayoutSaveRequestDto & { hall: HallDto }): string {
  if (isBlank(request.layoutName)) {
    // Safe: validation has already guaranteed a non-blank hall name (BR-04).
    return (request.hall.name as string).trim();
  }

  return (request.layoutName as string).trim();
}

/**
 * LayoutService.copyHall(). The client `id` is never copied (BR-18). The shape is stored
 * normalised; the hall NAME is stored untrimmed — unlike the layout name. That asymmetry is
 * in the Java (LayoutService.java:311-317) and is visible in responses, so it is kept.
 */
function copyHall(source: HallDto): HallWrite {
  return {
    name: source.name ?? null,
    shape: normalizeShape(source.shape),
    width: source.width ?? null,
    length: source.length ?? null,
    radius: source.radius ?? null,
  };
}

/** BR-17. LayoutService.copyStalls(): defaults applied, ids dropped. */
function copyStalls(input: Array<StallDto | null> | null | undefined): StallWrite[] {
  const output: StallWrite[] = [];

  for (const stall of input ?? []) {
    if (stall == null) continue;

    output.push({
      name: isBlank(stall.name) ? 'Shop' : (stall.name as string).trim(),
      width: n(stall.width),
      length: n(stall.length),
      height: n(stall.height),
      posX: n(stall.posX),
      posZ: n(stall.posZ),
      // Not trimmed, as in the Java (LayoutService.java:384-389).
      color: isBlank(stall.color) ? '#3498db' : (stall.color as string),
      gateSide: normalizeGate(stall.gateSide),
    });
  }

  return output;
}

function toHallResponse(hall: HallEntity | null): HallResponse | null {
  if (hall === null) return null;

  return {
    id: hall.id,
    name: hall.name,
    shape: hall.shape,
    width: hall.width,
    length: hall.length,
    radius: hall.radius,
  };
}

/** Explicit mapping so persistence-only columns (layout_id) never reach the wire. */
function toStallResponse(stall: StallEntity): StallResponse {
  return {
    id: stall.id,
    name: stall.name,
    width: stall.width,
    length: stall.length,
    height: stall.height,
    posX: stall.posX,
    posZ: stall.posZ,
    color: stall.color,
    gateSide: stall.gateSide,
  };
}

/** LayoutService.detail(): the deliberately redundant envelope (ADR-009). */
function toDetail(aggregate: LayoutAggregate, message: string | null): LayoutDetailResponse {
  const hall = toHallResponse(aggregate.hall);
  const stalls = aggregate.stalls.map(toStallResponse);

  return {
    message,
    layout: {
      id: aggregate.layout.id,
      name: aggregate.layout.name,
      hallWidth: aggregate.layout.hallWidth,
      hallLength: aggregate.layout.hallLength,
      hallHeight: aggregate.layout.hallHeight,
      hall,
      stalls,
    },
    hall,
    stalls,
  };
}
