import { assertPlacements } from './placement/assert-placements';
import { createHash } from 'node:crypto';
import { contained, ring, rotate, stallPolygon } from './placement/polygon-geometry';
import {
  normalizeFootprint,
  normalizeOpenEdges,
  sidesOfEdges,
  type NormalizedFootprint,
} from './placement/stall-footprint';
import { splitSuffix } from './split-numbering';
import { DataIntegrityDomainError } from '../common/errors/domain.errors';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BadRequestDomainError, PlacementRejectedError } from '../common/errors/domain.errors';
import type { LimitsConfig } from '../config/configuration';
import type {
  HallResponse,
  LayoutAuditResponse,
  LayoutDetailResponse,
  LayoutSummaryResponse,
  StallBookedResponse,
  StallResponse,
} from './dto/layout-response.dto';
import type {
  HallDto,
  LayoutSaveRequestDto,
  StallDto,
  SplitStallDto,
} from './dto/layout-save-request.dto';
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
} from './placement/placement-rules';

/** Options for trusted imports only (scripts and the token-protected seed-import route). */
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

  async save(
    request: LayoutSaveRequestDto,
    options: WriteOptions = {},
  ): Promise<LayoutDetailResponse> {
    const write = this.validateAndBuild(request);

    // Keep explicit section identifiers; assign generated numbers only where absent.
    validateNumbers(write);
    if (!options.skipPlacementRules) assertPlacementRules(write);
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

    const saved = await this.layouts.replace(id, async (current) => {
      const issued = new Map(
        current.stalls.filter((s) => s.stallNumber).map((s) => [s.stallNumber!, s]),
      );
      keepExistingNumbers(write, new Set(issued.keys()));
      for (const stall of write.stalls) {
        const before = stall.stallNumber ? issued.get(stall.stallNumber) : undefined;
        stall.parentStallNumber = before?.parentStallNumber ?? null;
        stall.isSplitParent = before?.isSplitParent ?? false;
      }
      for (const parent of current.stalls.filter((s) => s.isSplitParent)) {
        const after = write.stalls.find((s) => s.stallNumber === parent.stallNumber);
        if (!after || after.status !== 'CANCELLED' || !sameFootprint(parent, after))
          throw new DataIntegrityDomainError(
            'Split parents must be retained, cancelled and geometrically unchanged.',
          );
      }
      if (!options.skipPlacementRules) assertPlacementRules(write);
      write.nextStallSeq = assignNewNumbers(write, current.layout.nextStallSeq);
      return write;
    });
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

    if (found.hall === null) {
      return { layoutId: id, ruleDriven: false, valid: true, entries: [] };
    }

    const stalls: PlacementStall[] = found.stalls.map((s) => ({
      ...s,
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

  async split(
    id: number,
    parentNumber: string,
    request: SplitStallDto,
  ): Promise<LayoutDetailResponse> {
    if (
      !request ||
      typeof request.idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(request.idempotencyKey)
    )
      throw new BadRequestDomainError(
        'idempotencyKey must contain 1–128 letters, digits, underscores or hyphens.',
      );
    if (
      !Array.isArray(request.children) ||
      request.children.length < 2 ||
      request.children.length > this.maxStalls
    )
      throw new BadRequestDomainError(`Split requires 2–${this.maxStalls} children.`);
    const hash = createHash('sha256')
      .update(JSON.stringify(canonical(request.children)))
      .digest('hex');
    const saved = await this.layouts.replace(id, async (current, manager) => {
      const prior = await manager.query(
        'SELECT parent_number, request_hash FROM layout_splits WHERE layout_id = $1 AND idempotency_key = $2',
        [id, request.idempotencyKey],
      );
      if (prior.length) {
        if (prior[0].parent_number !== parentNumber || prior[0].request_hash !== hash)
          throw new DataIntegrityDomainError(
            'Idempotency key was already used with a different split request.',
          );
        return null;
      }
      const parent = current.stalls.find((s) => s.stallNumber === parentNumber);
      if (!parent) throw new BadRequestDomainError(`Parent stall not found: ${parentNumber}`);
      if (parent.isSplitParent || parent.status === 'CANCELLED')
        throw new DataIntegrityDomainError('Parent has already been split or cancelled.');
      if (parent.footprint?.length)
        throw new BadRequestDomainError(
          'Custom-shaped stalls (e.g. L-shaped) cannot be split; edit the outline instead.',
        );
      if (!current.hall) throw new BadRequestDomainError('Hall data is required.');
      const children = request.children.map((child, index) => ({
        ...child,
        stallNumber: `${parentNumber}-${splitSuffix(index)}`,
      }));
      const write = this.validateAndBuild({
        layoutName: current.layout.name,
        eventType: current.layout.eventType,
        // A split changes stalls only: the layout keeps its chosen rules.
        ruleIds: current.layout.ruleIds ?? [],
        hall: toHallResponse(current.hall) as HallDto,
        stalls: [
          ...current.stalls.map((s) => ({ ...s, status: s === parent ? 'CANCELLED' : s.status })),
          ...children,
        ],
      });
      for (let i = 0; i < current.stalls.length; i++) {
        write.stalls[i].parentStallNumber = current.stalls[i].parentStallNumber;
        write.stalls[i].isSplitParent =
          current.stalls[i].isSplitParent || current.stalls[i] === parent;
      }
      for (const child of write.stalls.slice(current.stalls.length)) {
        if (child.status === 'CANCELLED')
          throw new BadRequestDomainError('Split children must be active stalls.');
        child.parentStallNumber = parentNumber;
        if (!contained(stallPolygon(child), [ring(stallPolygon(parent))]))
          throw new PlacementRejectedError(
            'Split children must stay inside the parent footprint.',
            [
              {
                code: 'SPLIT_OUTSIDE_PARENT',
                stallNumber: child.stallNumber,
                parentStallNumber: parentNumber,
              },
            ],
          );
      }
      validateNumbers(write);
      assertPlacementRules(write);
      write.nextStallSeq = current.layout.nextStallSeq;
      await manager.query(
        'INSERT INTO layout_splits(layout_id, parent_number, idempotency_key, request_hash, parent_snapshot, child_numbers) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          id,
          parentNumber,
          request.idempotencyKey,
          hash,
          JSON.stringify(parent),
          JSON.stringify(children.map((c) => c.stallNumber)),
        ],
      );
      return write;
    });
    if (!saved) throw notFound(id);
    return toDetail(saved, 'Stall split successfully.');
  }

  /**
   * An exhibitor books a stall: AVAILABLE -> BOOKED, nothing else changes. Only an AVAILABLE stall
   * can be booked, so a stall is never booked twice: the second request sees BOOKED and gets 409.
   */
  async book(id: number, stallNumber: string): Promise<StallBookedResponse> {
    const booked = await this.layouts.updateStall(id, stallNumber, (stall) => {
      if (!stall) throw new BadRequestDomainError(`Stall not found: ${stallNumber}`);
      if (stall.status !== 'AVAILABLE')
        throw new DataIntegrityDomainError(`Stall ${stall.name} is not available for booking.`);
      stall.status = 'BOOKED';
    });
    if (booked === null) throw notFound(id);

    return { message: 'Stall booked successfully.', layoutId: id, stall: toStallResponse(booked) };
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
      ruleIds: validateRuleIds(request.ruleIds),
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
    if (stall.stallNumber?.startsWith(prefix)) {
      const suffix = stall.stallNumber.slice(prefix.length);
      if (/^\d+$/.test(suffix)) {
        const value = Number(suffix);
        if (!Number.isSafeInteger(value) || value >= 2147483646)
          throw new BadRequestDomainError(
            'Numeric stall identifier exceeds the sequence capacity.',
          );
        seq = Math.max(seq, value + 1);
      }
    }
  }

  for (const stall of write.stalls) {
    if (stall.stallNumber === null) {
      do {
        // Use the same cap as explicit numeric identifiers so generated numbers can
        // be reloaded and saved again, and next_stall_seq remains a PostgreSQL int.
        if (!Number.isSafeInteger(seq) || seq >= 2147483646)
          throw new BadRequestDomainError(
            'Numeric stall identifier exceeds the sequence capacity.',
          );
        stall.stallNumber = formatStallNumber(prefix, seq++);
      } while (
        write.stalls.some((other) => other !== stall && other.stallNumber === stall.stallNumber)
      );
    }
  }

  return seq;
}

/** Validate the entire final state, including unchanged stalls and changed hall rules. */
function assertPlacementRules(write: LayoutWrite): void {
  assertPlacements(write.hall, write.eventType as EventType, write.stalls);
}

function sameFootprint(a: Footprint, b: Footprint): boolean {
  const close = (x: number, y: number): boolean => Math.abs(x - y) < 1e-6;
  return (
    close(a.rotation ?? 0, b.rotation ?? 0) &&
    close(a.posX, b.posX) &&
    close(a.posZ, b.posZ) &&
    close(a.width, b.width) &&
    close(a.length, b.length) &&
    JSON.stringify(a.footprint ?? null) === JSON.stringify(b.footprint ?? null)
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
    let openSides = normalizeOpenSidesList(stall.openSides, normalizeGate(stall.gateSide));
    const rotation = (((stall.rotation ?? 0) % 360) + 360) % 360;

    // Custom (polygon) stall: store the canonical outline (validated already), its bounding box
    // as width/length, and (posX, posZ) moved to the bounding-box centre so every field keeps the
    // meaning it has for a rectangle. The legacy side list summarises the open edges.
    let custom: Pick<StallWrite, 'footprint' | 'openEdges'> = { footprint: null, openEdges: null };
    let width = n(stall.width);
    let length = n(stall.length);
    let posX = n(stall.posX);
    let posZ = n(stall.posZ);
    if (stall.footprint != null) {
      const normalized = normalizeFootprint(stall.footprint) as NormalizedFootprint;
      const openEdges = [
        ...new Set(
          ((normalizeOpenEdges(stall.openEdges, stall.footprint.length) as number[]) ?? [])
            .map((e) => normalized.edgeMap.get(e))
            .filter((e): e is number => e !== undefined),
        ),
      ].sort((a, b) => a - b);
      const shift = rotate(normalized.offset, rotation);
      custom = { footprint: normalized.points, openEdges };
      width = normalized.width;
      length = normalized.length;
      posX = Math.round((posX + shift.x) * 1e6) / 1e6;
      posZ = Math.round((posZ + shift.z) * 1e6) / 1e6;
      const sides = sidesOfEdges(normalized.points, openEdges);
      if (sides.length) openSides = sides;
    }

    output.push({
      ...custom,
      rotation,
      parentStallNumber: null,
      isSplitParent: false,
      name: isBlank(stall.name) ? 'Shop' : (stall.name as string).trim(),
      width,
      length,
      height: n(stall.height),
      posX,
      posZ,
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
    rotation: stall.rotation ?? 0,
    parentStallNumber: stall.parentStallNumber ?? null,
    isSplitParent: stall.isSplitParent ?? false,
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
    // Custom (polygon) stalls only: a rectangle's response keeps exactly its previous shape.
    ...(stall.footprint?.length
      ? { footprint: stall.footprint, openEdges: stall.openEdges ?? [] }
      : {}),
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
      ruleIds: aggregate.layout.ruleIds ?? [],
      hall,
      stalls,
    },
    hall,
    stalls,
  };
}

/**
 * The plotting rules chosen for a layout: positive whole ids, deduplicated, in the order given.
 * A rule deleted later simply stops being listed; the ids are not foreign keys.
 */
function validateRuleIds(raw: unknown[] | null | undefined): number[] {
  const ids: number[] = [];
  for (const value of raw ?? []) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new BadRequestDomainError('ruleIds must be rule ids (positive whole numbers).');
    }
    if (!ids.includes(value)) ids.push(value);
  }
  if (ids.length > 500) throw new BadRequestDomainError('A layout can list at most 500 rules.');
  return ids;
}

function validateNumbers(write: LayoutWrite): void {
  const seen = new Set<string>();
  for (const stall of write.stalls) {
    const number = stall.stallNumber;
    if (number === null) continue;
    if (number.length > 255 || seen.has(number))
      throw new PlacementRejectedError(
        'Stall identifiers must be unique and at most 255 characters.',
        [{ code: 'INVALID_STALL_IDENTIFIER', stallNumber: number }],
      );
    seen.add(number);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
