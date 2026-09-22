import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BadRequestDomainError, PlacementRejectedError } from '../common/errors/domain.errors';
import type { LimitsConfig } from '../config/configuration';
import type {
  HallResponse,
  LayoutAuditResponse,
  LayoutDetailResponse,
  LayoutSummaryResponse,
  StallResponse,
} from './dto/layout-response.dto';
import type { HallDto, LayoutSaveRequestDto, StallDto } from './dto/layout-save-request.dto';
import type { HallEntity } from './entities/hall.entity';
import type { BlockedArea } from './entities/hall.entity';
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
  normalizeOpenSidesList,
  normalizeShape,
  validateLayoutRequest,
} from './layout.validator';
import {
  buildPlacementContext,
  effectiveRules,
  hallGeometryResponse,
  isRuleDriven,
  normalizeEventType,
  normalizeStatus,
  validateHallGeometry,
} from './placement/hall-geometry';
import {
  auditLayout,
  EventType,
  Footprint,
  formatStallNumber,
  PlacementStall,
  validatePlacement,
} from './placement/placement-rules';

/** Options for trusted callers only (seed scripts); never reachable from HTTP. */
export interface WriteOptions {
  /**
   * Import of EXISTING production placements. Skips BR-24: those stalls are existing layout
   * state, which the rules report (audit) but never block.
   */
  skipPlacementRules?: boolean;
}

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

  async save(request: LayoutSaveRequestDto, options: WriteOptions = {}): Promise<LayoutDetailResponse> {
    const write = this.validateAndBuild(request);

    // A new layout owns no stall numbers yet: every stall is new, numbered from 1.
    keepExistingNumbers(write, new Set());
    if (!options.skipPlacementRules) assertPlacementRules(write, new Map());
    write.nextStallSeq = assignNewNumbers(write, 1);

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

  async update(
    id: number,
    request: LayoutSaveRequestDto,
    options: WriteOptions = {},
  ): Promise<LayoutDetailResponse> {
    // Java order: validate the body FIRST, then look the layout up (LayoutService.java:148-155).
    // A bad body for a missing id therefore reports the validation error, not "not found".
    const write = this.validateAndBuild(request);

    const current = await this.layouts.findById(id);
    if (current === null) throw notFound(id);

    // BR-25: numbers the layout already issued survive the stall re-insert (ADR-012).
    const issued = new Map<string, Footprint>();
    for (const stall of current.stalls) {
      if (stall.stallNumber) issued.set(stall.stallNumber, stall);
    }
    keepExistingNumbers(write, new Set(issued.keys()));
    if (!options.skipPlacementRules) assertPlacementRules(write, issued);
    write.nextStallSeq = assignNewNumbers(write, current.layout.nextStallSeq);

    const saved = await this.layouts.replace(id, write);
    if (saved === null) throw notFound(id);

    return toDetail(saved, 'Layout updated successfully.');
  }

  /**
   * Every rule problem in the saved layout, per stall. Reporting only — this is how existing
   * layouts that predate the rules are shown to the user without blocking them.
   */
  async audit(id: number): Promise<LayoutAuditResponse> {
    const found = await this.layouts.findById(id);
    if (found === null) throw notFound(id);

    if (found.hall === null || !isRuleDriven(found.hall)) {
      return { layoutId: id, ruleDriven: false, valid: true, entries: [] };
    }

    const stalls: PlacementStall[] = found.stalls.map((s) => ({
      id: String(s.id),
      stallNumber: s.stallNumber,
      status: s.status,
      posX: s.posX,
      posZ: s.posZ,
      width: s.width,
      length: s.length,
    }));
    const entries = auditLayout(
      buildPlacementContext(found.hall, normalizeEventType(found.layout.eventType), stalls),
    );

    return { layoutId: id, ruleDriven: true, valid: entries.length === 0, entries };
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
      eventType: normalizeEventType(request.eventType),
      // Set by the numbering step before the write.
      nextStallSeq: 1,
      stalls: copyStalls(request.stalls),
    };
  }
}

/**
 * BR-25, first half: a client-sent stall number is kept only if this layout already issued it,
 * and only once. Anything else is cleared, so a client can never pick or forge a number.
 */
function keepExistingNumbers(write: LayoutWrite, issued: ReadonlySet<string>): void {
  const seen = new Set<string>();

  for (const stall of write.stalls) {
    const number = stall.stallNumber;
    if (number === null || !issued.has(number)) {
      stall.stallNumber = null;
      continue;
    }
    if (seen.has(number)) {
      throw new BadRequestDomainError(`Stall number ${number} is used by more than one stall.`);
    }
    seen.add(number);
  }
}

/**
 * BR-25, second half: stalls without a number get the next ones in sequence. The sequence only
 * grows, so a cancelled or removed stall's number is never handed out again.
 * Returns the sequence value to store.
 */
function assignNewNumbers(write: LayoutWrite, nextSeq: number): number {
  const prefix = effectiveRules(write.hall.rules).stallNumberPrefix;
  let seq = Math.max(1, nextSeq);

  for (const stall of write.stalls) {
    if (stall.stallNumber === null) {
      stall.stallNumber = formatStallNumber(prefix, seq);
      seq++;
    }
  }

  return seq;
}

/**
 * BR-24. For a rule-driven hall, every stall that is new, moved or resized must pass every
 * placement rule. A stall that keeps an issued number at the same footprint is existing layout
 * state: it is reported by audit() but not blocked (decision: block new/moved, report old).
 *
 * All failing stalls are reported, not only the first, each with WHAT is wrong and WHERE.
 */
function assertPlacementRules(write: LayoutWrite, issued: ReadonlyMap<string, Footprint>): void {
  if (!isRuleDriven(write.hall)) return;

  // Stall ids are the request index: the client maps them back onto its own list.
  const stalls: PlacementStall[] = write.stalls.map((s, i) => ({
    id: String(i),
    stallNumber: s.stallNumber,
    status: s.status,
    posX: s.posX,
    posZ: s.posZ,
    width: s.width,
    length: s.length,
  }));
  const ctx = buildPlacementContext(write.hall, write.eventType as EventType, stalls);

  const problems: Array<Record<string, unknown>> = [];
  let firstMessage = '';

  write.stalls.forEach((stall, index) => {
    if (stall.status === 'CANCELLED') return;

    const before = stall.stallNumber ? issued.get(stall.stallNumber) : undefined;
    if (before && sameFootprint(before, stall)) return;

    const result = validatePlacement(stall, ctx, String(index));
    for (const violation of result.violations) {
      if (!firstMessage) {
        firstMessage = `Stall ${index} (${stall.name}) placement rejected: ${violation.message}`;
      }
      problems.push({ stallIndex: index, stallNumber: stall.stallNumber, ...violation });
    }
  });

  if (problems.length) throw new PlacementRejectedError(firstMessage, problems);
}

function sameFootprint(a: Footprint, b: Footprint): boolean {
  const close = (x: number, y: number): boolean => Math.abs(x - y) < 1e-6;
  return (
    close(a.posX, b.posX) && close(a.posZ, b.posZ) && close(a.width, b.width) && close(a.length, b.length)
  );
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
    blockedAreas: (source.blockedAreas as BlockedArea[] | null | undefined) ?? null,
    ...validateHallGeometry(source),
  };
}

/** BR-17. LayoutService.copyStalls(): defaults applied, ids dropped. */
function copyStalls(input: Array<StallDto | null> | null | undefined): StallWrite[] {
  const output: StallWrite[] = [];

  for (const stall of input ?? []) {
    if (stall == null) continue;

    // gateSide stays the first open side, so the varchar column and the Java
    // contract keep working; openSides is the full list the 3D view renders.
    const openSides = normalizeOpenSidesList(stall.openSides, normalizeGate(stall.gateSide));

    output.push({
      name: isBlank(stall.name) ? 'Shop' : (stall.name as string).trim(),
      width: n(stall.width),
      length: n(stall.length),
      height: n(stall.height),
      posX: n(stall.posX),
      posZ: n(stall.posZ),
      // Not trimmed, as in the Java (LayoutService.java:384-389).
      color: isBlank(stall.color) ? '#3498db' : (stall.color as string),
      gateSide: openSides[0],
      openSides,
      stallNumber: isBlank(stall.stallNumber) ? null : (stall.stallNumber as string).trim(),
      status: normalizeStatus(stall.status),
      stallTypeId: isBlank(stall.stallTypeId) ? null : (stall.stallTypeId as string).trim(),
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
    blockedAreas: hall.blockedAreas ?? null,
    ...hallGeometryResponse(hall),
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
    // Rows written before the open_sides column existed derive it from gate_side.
    openSides: stall.openSides?.length
      ? stall.openSides
      : stall.gateSide != null
        ? [stall.gateSide]
        : null,
    stallNumber: stall.stallNumber ?? null,
    status: stall.status ?? 'AVAILABLE',
    stallTypeId: stall.stallTypeId ?? null,
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
      eventType: aggregate.layout.eventType ?? 'B2B',
      hall,
      stalls,
    },
    hall,
    stalls,
  };
}
