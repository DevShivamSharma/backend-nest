import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import type { LayoutSummaryResponse } from './dto/layout-response.dto';
import { HallEntity } from './entities/hall.entity';
import { LayoutEntity } from './entities/layout.entity';
import { StallEntity } from './entities/stall.entity';

export interface HallWrite {
  name: string | null;
  shape: string;
  width: number | null;
  length: number | null;
  radius: number | null;
}

export interface StallWrite {
  name: string;
  width: number;
  length: number;
  height: number;
  posX: number;
  posZ: number;
  color: string;
  gateSide: string;
}

export interface LayoutWrite {
  name: string;
  hallWidth: number;
  hallLength: number;
  hallHeight: number;
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
        }),
      );

      const stalls = await this.insertStalls(manager, layout.id, write.stalls);

      return { layout, hall, stalls };
    });
  }

  async findById(id: number): Promise<LayoutAggregate | null> {
    return this.load(this.dataSource.manager, id);
  }

  /**
   * Full replacement (BR-16, BR-19 update): the hall row is mutated in place and keeps its id;
   * every stall row is deleted and re-inserted, so stall ids change on every update — the
   * observable Java behaviour, preserved deliberately (ADR-012).
   *
   * Returns null when the layout does not exist.
   */
  replace(id: number, write: LayoutWrite): Promise<LayoutAggregate | null> {
    return this.dataSource.transaction(async (manager) => {
      const layout = await manager.findOneBy(LayoutEntity, { id });
      if (layout === null) return null;

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
      await manager.save(layout);

      await manager.delete(StallEntity, { layoutId: id });
      const stalls = await this.insertStalls(manager, id, write.stalls);

      return { layout, hall, stalls };
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
      const layout = await manager.findOneBy(LayoutEntity, { id });
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
