import { assertPlacements } from '../layouts/placement/assert-placements';
import { normalizeEventType } from '../layouts/placement/hall-geometry';
import { StallEntity } from '../layouts/entities/stall.entity';
import { Injectable } from '@nestjs/common';
import { DataSource, In, Not } from 'typeorm';

import { HallEntity } from '../layouts/entities/hall.entity';
import { LayoutEntity } from '../layouts/entities/layout.entity';
import type { HallWrite } from '../layouts/layout.repository';

/**
 * All persistence for the standalone /api/halls endpoints. No business rules here.
 *
 * `HallEntity` and `HallWrite` are reused from the layouts feature rather than redeclared —
 * there is one `hall` table and one set of writable columns, and two copies would drift.
 *
 * The Java talked to `HallRepository` straight from the controller with no `@Transactional`
 * anywhere (R-10); `update` below is a single transaction instead of the Java's
 * read-modify-write across two.
 */
@Injectable()
export class HallRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Every hall row. `HallController.getAllHalls` used an unpaginated `findAll()` and this keeps
   * that — pagination is post-demo work.
   *
   * Ordered by id, which the Java left unspecified. A stable order costs nothing and makes the
   * response reproducible.
   */
  findAll(): Promise<HallEntity[]> {
    return this.dataSource.getRepository(HallEntity).find({ order: { id: 'ASC' } });
  }

  /**
   * Halls that no layout owns — the "master" halls a planner can start designing in.
   *
   * Two kinds of row share the `hall` table. A hall created through POST /api/halls stands on
   * its own; a hall created by saving a layout is that layout's private copy, because the save
   * path always inserts a new hall row and ignores any id sent by the client (BR-18). Without
   * this filter the hall picker would grow by one entry every time a layout is saved.
   *
   * Two plain queries rather than a NOT IN subquery: at demo scale the cost is irrelevant and
   * this version is obvious to read and to verify.
   */
  async findStandalone(): Promise<HallEntity[]> {
    const owned = await this.dataSource
      .getRepository(LayoutEntity)
      .createQueryBuilder('layout')
      .select('layout.hallId', 'hallId')
      .where('layout.hallId IS NOT NULL')
      .getRawMany<{ hallId: number }>();

    const ownedIds = owned.map((row) => row.hallId);
    const halls = this.dataSource.getRepository(HallEntity);

    // `In([])` is not valid SQL, so the empty case is handled separately.
    if (ownedIds.length === 0) {
      return halls.find({ order: { id: 'ASC' } });
    }

    return halls.find({ where: { id: Not(In(ownedIds)) }, order: { id: 'ASC' } });
  }

  findById(id: number): Promise<HallEntity | null> {
    return this.dataSource.getRepository(HallEntity).findOneBy({ id });
  }

  /** The id is always generated: the Java forced `hall.setId(null)` first (HallController:58). */
  create(write: HallWrite): Promise<HallEntity> {
    const repository = this.dataSource.getRepository(HallEntity);

    return repository.save(repository.create(write));
  }

  /**
   * Full overwrite of all five business columns, as in the Java.
   * Returns null when the hall does not exist, so the service can raise the not-found message.
   */
  update(id: number, write: HallWrite): Promise<HallEntity | null> {
    return this.dataSource.transaction(async (manager) => {
      // Match layout writes' lock order: owner layout(s), then hall, then stalls.
      const owners = await manager
        .createQueryBuilder(LayoutEntity, 'layout')
        .where('layout.hallId = :id', { id })
        .orderBy('layout.id', 'ASC')
        .setLock('pessimistic_write')
        .getMany();
      const existing = await manager.findOneBy(HallEntity, { id });
      if (existing === null) return null;
      for (const owner of owners) {
        const stalls = await manager.find(StallEntity, {
          where: { layoutId: owner.id },
          order: { id: 'ASC' },
        });
        assertPlacements(write, normalizeEventType(owner.eventType), stalls);
        await manager.update(LayoutEntity, owner.id, {
          hallWidth: write.width ?? 0,
          hallLength: write.length ?? 0,
          status: 'DRAFT',
          publishedAt: null,
          publishOverrides: null,
        });
      }
      return manager.save(manager.merge(HallEntity, existing, write));
    });
  }

  /**
   * Returns false when the hall does not exist.
   *
   * A hall still referenced by `layouts.hall_id` raises a foreign-key violation, which
   * `AllExceptionsFilter` turns into 409 — the same status the Java produced through
   * `DataIntegrityViolationException` (02-api-inventory.md section 7-10).
   */
  /** The saved layout whose private hall copy this is, or null for a master hall. */
  async owningLayoutName(id: number): Promise<string | null> {
    const layout = await this.dataSource.getRepository(LayoutEntity).findOneBy({ hallId: id });
    return layout?.name ?? null;
  }

  delete(id: number): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOneBy(HallEntity, { id });
      if (existing === null) return false;

      await manager.delete(HallEntity, { id });

      return true;
    });
  }
}
