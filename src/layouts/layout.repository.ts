import { Injectable } from '@nestjs/common';
import { DataIntegrityDomainError } from '../common/errors/domain.errors';
import { DataSource, EntityManager } from 'typeorm';

import type { LayoutSummaryResponse } from './dto/layout-response.dto';
import {
  BlockedArea,
  HallAmenity,
  HallCompass,
  HallEntity,
  HallLegend,
  HallMarker,
} from './entities/hall.entity';
import { LayoutEntity } from './entities/layout.entity';
import { StallEntity } from './entities/stall.entity';
import type { HallOpening, HallZone, LayoutRules, Point } from './placement/placement-rules';

export interface HallWrite {
  planningZones?: import('./placement/planning-zones').PlanningZone[] | null;
  name: string | null;
  shape: string;
  width: number | null;
  length: number | null;
  radius: number | null;
  blockedAreas?: BlockedArea[] | null;
  boundary?: Point[] | null;
  zones?: HallZone[] | null;
  openings?: HallOpening[] | null;
  markers?: HallMarker[] | null;
  amenities?: HallAmenity[] | null;
  compass?: HallCompass | null;
  legends?: HallLegend[] | null;
  rules?: Partial<LayoutRules> | null;
}

export interface StallWrite {
  bookingQuote?: import('../pricing/pricing-policy').StallQuote | null;
  footprint?: Point[] | null;
  openEdges?: number[] | null;
  rotation?: number;
  parentStallNumber?: string | null;
  isSplitParent?: boolean;
  name: string;
  width: number;
  length: number;
  height: number;
  posX: number;
  posZ: number;
  color: string;
  /** First open side — kept for the varchar column and the Java contract. */
  gateSide: string;
  openSides: string[];
  stallNumber: string | null;
  status: string;
  stallTypeId: string | null;
}

export interface LayoutWrite {
  status?: 'DRAFT' | 'PUBLISHED';
  publishedAt?: Date | null;
  publishOverrides?: LayoutEntity['publishOverrides'];
  name: string;
  hallWidth: number;
  hallLength: number;
  hallHeight: number;
  eventType: string;
  /** Plotting rules chosen for this layout. */
  ruleIds: number[];
  /** Sequence value to store after numbering this write's stalls. */
  nextStallSeq: number;
  hall: HallWrite;
  stalls: StallWrite[];
}

/** A layout with the hall and stalls it owns. */
export interface LayoutAggregate {
  layout: LayoutEntity;
  hall: HallEntity | null;
  stalls: StallEntity[];
}

/**
 * All persistence for layouts. No business rules here.
 *
 * The Java got its write behaviour from JPA configuration on Layout.java
 * (`cascade = ALL`, `orphanRemoval = true`). Here the same effects are written out explicitly,
 * one transaction per operation, so each can be read and defended on its own.
 */
@Injectable()
export class LayoutRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** BR-19 (create): always a NEW hall row, a new layout row and new stall rows. */
  create(write: LayoutWrite): Promise<LayoutAggregate> {
    return this.dataSource.transaction(async (manager) => {
      const hall = await manager.save(manager.create(HallEntity, write.hall));

      const layout = await manager.save(
        manager.create(LayoutEntity, {
          name: write.name,
          hallWidth: write.hallWidth,
          hallLength: write.hallLength,
          hallHeight: write.hallHeight,
          hallId: hall.id,
          eventType: write.eventType,
          ruleIds: write.ruleIds.length ? write.ruleIds : null,
          nextStallSeq: write.nextStallSeq,
          status: write.status ?? 'DRAFT',
          publishedAt: write.publishedAt ?? null,
          publishOverrides: write.publishOverrides ?? null,
        }),
      );

      const stalls = await this.insertStalls(manager, layout.id, write.stalls);

      return { layout, hall, stalls };
    });
  }

  async findById(id: number): Promise<LayoutAggregate | null> {
    return this.dataSource.transaction('REPEATABLE READ', (manager) => this.load(manager, id));
  }

  /**
   * Full replacement (BR-16, BR-19 update): the hall row is mutated in place and keeps its id;
   * every stall row is deleted and re-inserted, so stall ids change on every update — the
   * observable Java behaviour, preserved deliberately (ADR-012).
   *
   * Returns null when the layout does not exist.
   */
  replace(
    id: number,
    build: (current: LayoutAggregate, manager: EntityManager) => Promise<LayoutWrite | null>,
  ): Promise<LayoutAggregate | null> {
    return this.dataSource.transaction(async (manager) => {
      const locked = await manager.findOne(LayoutEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) return null;
      const current = (await this.load(manager, id))!;
      const write = await build(current, manager);
      if (write === null) return current;
      // A stale editor must not erase or change an accepted priced booking. Preserve its receipt
      // across the legacy delete/reinsert save, keyed by the stable stall number.
      for (const booked of current.stalls.filter(s => s.bookingQuote)) {
        const next = write.stalls.find(s => s.stallNumber === booked.stallNumber);
        const same = next && next.status === 'BOOKED' &&
          ['width', 'length', 'height', 'posX', 'posZ', 'rotation'].every(k => (next as any)[k] === (booked as any)[k]) &&
          JSON.stringify(next.footprint ?? null) === JSON.stringify(booked.footprint ?? null) &&
          JSON.stringify(next.openEdges ?? null) === JSON.stringify(booked.openEdges ?? null) &&
          JSON.stringify(next.openSides) === JSON.stringify(booked.openSides);
        if (!same) throw new DataIntegrityDomainError(`Booked stall ${booked.stallNumber} cannot be removed or changed. Reload the layout.`);
        next.bookingQuote = booked.bookingQuote;
      }
      const layout = current.layout;
      const existingHall =
        layout.hallId === null ? null : await manager.findOneBy(HallEntity, { id: layout.hallId });

      const hall = await manager.save(
        existingHall === null
          ? manager.create(HallEntity, write.hall)
          : manager.merge(HallEntity, existingHall, write.hall),
      );

      layout.name = write.name;
      layout.hallWidth = write.hallWidth;
      layout.hallLength = write.hallLength;
      layout.hallHeight = write.hallHeight;
      layout.hallId = hall.id;
      layout.eventType = write.eventType;
      layout.ruleIds = write.ruleIds.length ? write.ruleIds : null;
      layout.nextStallSeq = write.nextStallSeq;
      layout.status = write.status ?? 'DRAFT';
      layout.publishedAt = write.publishedAt ?? null;
      layout.publishOverrides = write.publishOverrides ?? null;
      await manager.save(layout);

      await manager.delete(StallEntity, { layoutId: id });
      const stalls = await this.insertStalls(manager, id, write.stalls);

      return { layout, hall, stalls };
    });
  }

  /**
   * One stall changed in place, under the same layout row lock as `replace()`: two changes to the
   * same layout (two exhibitors booking one stall, or a booking and a save) never interleave.
   * `change` decides what to do with the stall it is given (null when the layout has no stall with
   * that number) and may throw; the stall is saved after it returns.
   *
   * Returns null when the layout does not exist (or when `change` lets a missing stall through).
   */
  updateStall(
    layoutId: number,
    stallNumber: string,
    change: (stall: StallEntity | null, layout: LayoutEntity) => void,
  ): Promise<StallEntity | null> {
    return this.dataSource.transaction(async (manager) => {
      const locked = await manager.findOne(LayoutEntity, {
        where: { id: layoutId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) return null;
      const stall = await manager.findOneBy(StallEntity, { layoutId, stallNumber });
      change(stall, locked);
      return stall && manager.save(stall);
    });
  }

  /**
   * BR-20: deleting a layout removes its stalls and its hall. Order follows the foreign keys:
   * stalls reference the layout, the layout references the hall.
   *
   * Returns false when the layout does not exist.
   */
  delete(id: number): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const layout = await manager.findOne(LayoutEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (layout === null) return false;

      await manager.delete(StallEntity, { layoutId: id });
      await manager.delete(LayoutEntity, { id });

      if (layout.hallId !== null) {
        await manager.delete(HallEntity, { id: layout.hallId });
      }

      return true;
    });
  }

  /**
   * BR-21, ADR-011. ONE query, newest first.
   *
   * The Java loaded every Layout entity with its EAGER hall and EAGER stall collection — 1 + 2N
   * queries and every stall row in memory — only to call `.size()` (LayoutService.java:63-107).
   * The JSON produced is identical. LEFT JOIN + COALESCE keep the Java null-hall branch:
   * a hall-less layout yields null / 0 fields.
   */
  listSummaries(): Promise<LayoutSummaryResponse[]> {
    return this.dataSource.query(`
      SELECT l.id                  AS "id",
             l.name                AS "name",
             l.status              AS "status",
             l.published_at        AS "publishedAt",
             h.id                  AS "hallId",
             h.name                AS "hallName",
             h.shape               AS "shape",
             COALESCE(h.width, 0)  AS "hallWidth",
             COALESCE(h.length, 0) AS "hallLength",
             h.radius              AS "radius",
             COUNT(s.id)           AS "stallCount"
        FROM layouts l
        LEFT JOIN hall   h ON h.id = l.hall_id
        LEFT JOIN stalls s ON s.layout_id = l.id
       GROUP BY l.id, h.id
       ORDER BY l.id DESC
    `);
  }

  private async load(manager: EntityManager, id: number): Promise<LayoutAggregate | null> {
    const layout = await manager.findOneBy(LayoutEntity, { id });
    if (layout === null) return null;

    const hall =
      layout.hallId === null ? null : await manager.findOneBy(HallEntity, { id: layout.hallId });

    const stalls = await manager.find(StallEntity, {
      where: { layoutId: id },
      order: { id: 'ASC' },
    });

    return { layout, hall, stalls };
  }

  private async insertStalls(
    manager: EntityManager,
    layoutId: number,
    stalls: StallWrite[],
  ): Promise<StallEntity[]> {
    if (stalls.length === 0) return [];

    return manager.save(stalls.map((stall) => manager.create(StallEntity, { ...stall, layoutId })));
  }
}
