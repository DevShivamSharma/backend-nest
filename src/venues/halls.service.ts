import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/http/authenticated-request';
import { EventHallEntity } from '../events/event.entity';
import { ExternalRefEntity } from '../integrations/external-ref.entity';
import { CreateHallDto, UpdateHallDto } from './dto/venue.dto';
import {
  blankFloor,
  floorArea,
  floorProblems,
  HallFloor,
  outlineFloor,
  sameFloor,
} from './floor/hall-floor';
import { withAnnotations } from './floor/hall-annotations';
import { FloorSource, HallEntity, HallFloorVersionEntity, HallUses } from './hall.entity';
import { VenueEntity } from './venue.entity';
import type { FloorVersionView, HallDetailView, HallSourceView, HallView } from './venue.views';

export interface NewFloorVersion {
  floor: HallFloor;
  source: FloorSource;
  sourceRef?: string | null;
  note?: string | null;
}

/**
 * The halls of an organisation's venues and the history of each hall's floor. A floor is never
 * changed in place: every change adds a version and moves the hall's pointer to it.
 */
@Injectable()
export class HallsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async listForVenue(organisationId: string, venueId: string): Promise<HallView[]> {
    await this.getVenue(this.dataSource.manager, organisationId, venueId);
    const halls = await this.dataSource.getRepository(HallEntity).find({
      where: { organisationId, venueId },
      order: { name: 'ASC' },
    });
    return this.views(this.dataSource.manager, halls);
  }

  async get(organisationId: string, hallId: string): Promise<HallDetailView> {
    const em = this.dataSource.manager;
    const hall = await this.getHall(em, organisationId, hallId);
    const venue = await this.getVenue(em, organisationId, hall.venueId);
    const versions = await em.getRepository(HallFloorVersionEntity).find({
      where: { hallId },
      relations: { createdBy: true },
      order: { version: 'DESC' },
    });
    const current = versions.find((v) => v.version === hall.currentVersion);
    if (!current) {
      throw new Error(`Hall ${hallId} has no floor version ${hall.currentVersion}.`);
    }
    const [view] = await this.views(em, [hall]);
    return {
      ...view,
      venue: { id: venue.id, name: venue.name },
      floor: current.floor,
      versions: versions.map((v) => HallsService.versionView(v, hall.currentVersion)),
    };
  }

  async floorVersion(
    organisationId: string,
    hallId: string,
    version: number,
  ): Promise<{ version: number; floor: HallFloor }> {
    await this.getHall(this.dataSource.manager, organisationId, hallId);
    const row = await this.dataSource
      .getRepository(HallFloorVersionEntity)
      .findOneBy({ hallId, version });
    if (!row) {
      throw new NotFoundException(`This hall has no version ${version}.`);
    }
    return { version: row.version, floor: row.floor };
  }

  /** A hall drawn from nothing: an empty rectangle, to be filled in later. */
  async create(
    organisationId: string,
    venueId: string,
    dto: CreateHallDto,
    actor: Actor,
  ): Promise<HallView> {
    let blank: HallFloor;
    try {
      blank = dto.outline ? outlineFloor(dto.outline) : blankFloor(dto.width, dto.depth);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const hall = await this.dataSource.transaction(async (em) => {
      await this.getVenue(em, organisationId, venueId);
      const created = await this.insertHall(
        em,
        {
          organisationId,
          venueId,
          name: dto.name,
          code: dto.code,
          level: dto.level,
          uses: dto.uses,
        },
        {
          floor: dto.annotations ? withAnnotations(blank, dto.annotations) : blank,
          source: 'blank',
        },
        actor,
      );
      await this.audit.record(
        {
          action: 'hall.created',
          actor,
          organisationId,
          targetType: 'hall',
          targetId: created.id,
          metadata: {
            name: created.name,
            width: blank.width,
            depth: blank.depth,
            ...(dto.outline ? { corners: dto.outline.length } : {}),
          },
        },
        em,
      );
      return created;
    });
    return (await this.views(this.dataSource.manager, [hall]))[0];
  }

  async update(
    organisationId: string,
    hallId: string,
    dto: UpdateHallDto,
    actor: Actor,
  ): Promise<HallView> {
    const hall = await this.dataSource.transaction(async (em) => {
      const hall = await this.getHall(em, organisationId, hallId, true);
      if (dto.annotations) {
        if (dto.expectedVersion !== hall.currentVersion)
          throw new ConflictException('The hall layout changed. Reload before editing helpers.');
        const current = await em.getRepository(HallFloorVersionEntity).findOneByOrFail({
          hallId,
          version: hall.currentVersion,
        });
        const floor = withAnnotations(current.floor, dto.annotations);
        if (!sameFloor(floor, current.floor))
          await this.addVersion(
            em,
            hall,
            {
              floor,
              source: current.source,
              sourceRef: current.sourceRef,
              note: 'Updated legends and helper text positions',
            },
            actor,
          );
      }
      const before = { name: hall.name, code: hall.code, level: hall.level, uses: hall.uses };
      if (dto.name !== undefined && dto.name !== hall.name) {
        await this.assertNameFree(em, hall.venueId, dto.name, hall.id);
        hall.name = dto.name;
      }
      if (dto.code !== undefined) hall.code = dto.code ?? null;
      if (dto.level !== undefined) hall.level = dto.level ?? null;
      if (dto.uses !== undefined) hall.uses = HallsService.uses(dto.uses);
      const saved = await em.getRepository(HallEntity).save(hall);
      await this.audit.record(
        {
          action: 'hall.updated',
          actor,
          organisationId,
          targetType: 'hall',
          targetId: hall.id,
          metadata: {
            name: saved.name,
            changed: Object.keys(before).filter(
              (key) =>
                JSON.stringify(before[key as keyof typeof before]) !==
                JSON.stringify(saved[key as keyof typeof before]),
            ),
            ...(dto.annotations ? { floorVersion: saved.currentVersion } : {}),
          },
        },
        em,
      );
      return saved;
    });
    return (await this.views(this.dataSource.manager, [hall]))[0];
  }

  async remove(organisationId: string, hallId: string, actor: Actor): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const hall = await this.getHall(em, organisationId, hallId);
      await this.assertNotInEvents(em, [hall]);
      await em.getRepository(ExternalRefEntity).delete({ organisationId, localId: hall.id });
      await em.getRepository(HallEntity).delete({ id: hall.id });
      await this.audit.record(
        {
          action: 'hall.deleted',
          actor,
          organisationId,
          targetType: 'hall',
          targetId: hall.id,
          metadata: { name: hall.name },
        },
        em,
      );
    });
  }

  /**
   * Deletes several halls of one venue at once, all or none: when any id is not a hall of this
   * venue, nothing is deleted. Each hall gets its own audit entry.
   */
  async removeMany(
    organisationId: string,
    venueId: string,
    hallIds: string[],
    actor: Actor,
  ): Promise<{ deleted: number }> {
    const ids = [...new Set(hallIds)];
    return this.dataSource.transaction(async (em) => {
      await this.getVenue(em, organisationId, venueId);
      const halls = await em.getRepository(HallEntity).find({
        where: { id: In(ids), organisationId, venueId },
        lock: { mode: 'pessimistic_write' },
      });
      if (halls.length !== ids.length) {
        throw new NotFoundException(
          'Some of these halls are not in this venue any more. Reload and try again.',
        );
      }
      await this.assertNotInEvents(em, halls);
      await em.getRepository(ExternalRefEntity).delete({ organisationId, localId: In(ids) });
      await em.getRepository(HallEntity).delete({ id: In(ids) });
      for (const hall of halls) {
        await this.audit.record(
          {
            action: 'hall.deleted',
            actor,
            organisationId,
            targetType: 'hall',
            targetId: hall.id,
            metadata: { name: hall.name, bulk: true },
          },
          em,
        );
      }
      return { deleted: halls.length };
    });
  }

  /** Makes an earlier floor current again, as a new version: history only ever grows. */
  async restore(
    organisationId: string,
    hallId: string,
    version: number,
    actor: Actor,
  ): Promise<HallDetailView> {
    await this.dataSource.transaction(async (em) => {
      const hall = await this.getHall(em, organisationId, hallId, true);
      if (version === hall.currentVersion) {
        throw new BadRequestException(`Version ${version} is already the current floor.`);
      }
      const old = await em.getRepository(HallFloorVersionEntity).findOneBy({ hallId, version });
      if (!old) {
        throw new NotFoundException(`This hall has no version ${version}.`);
      }
      const added = await this.addVersion(
        em,
        hall,
        { floor: old.floor, source: 'restore', note: `Restored from version ${version}` },
        actor,
      );
      await this.audit.record(
        {
          action: 'hall.floor_restored',
          actor,
          organisationId,
          targetType: 'hall',
          targetId: hall.id,
          metadata: { name: hall.name, from: version, version: added },
        },
        em,
      );
    });
    return this.get(organisationId, hallId);
  }

  // --- building blocks, also used by imports ----------------------------------------------------

  async insertHall(
    em: EntityManager,
    details: {
      organisationId: string;
      venueId: string;
      name: string;
      code?: string | null;
      level?: string | null;
      uses?: HallUses;
    },
    first: NewFloorVersion,
    actor: Actor,
  ): Promise<HallEntity> {
    HallsService.assertFloor(first.floor);
    await this.assertNameFree(em, details.venueId, details.name);
    const hall = await em.getRepository(HallEntity).save(
      em.getRepository(HallEntity).create({
        organisationId: details.organisationId,
        venueId: details.venueId,
        name: details.name,
        code: details.code ?? null,
        level: details.level ?? null,
        uses: HallsService.uses(details.uses ?? {}),
        width: first.floor.width,
        depth: first.floor.depth,
        floorArea: floorArea(first.floor),
        currentVersion: 1,
      }),
    );
    await em.getRepository(HallFloorVersionEntity).insert({
      hallId: hall.id,
      version: 1,
      floor: first.floor,
      source: first.source,
      sourceRef: first.sourceRef ?? null,
      note: first.note ?? null,
      createdById: actor.id,
    });
    return hall;
  }

  /** Adds a floor version and makes it current. The hall must be locked by the caller. */
  async addVersion(
    em: EntityManager,
    hall: HallEntity,
    next: NewFloorVersion,
    actor: Actor,
  ): Promise<number> {
    HallsService.assertFloor(next.floor);
    const version = hall.currentVersion + 1;
    // The newest version may not be the current one after a restore; number after the newest.
    const newest = await em
      .getRepository(HallFloorVersionEntity)
      .maximum('version', { hallId: hall.id });
    const number = Math.max(version, (newest ?? 0) + 1);
    await em.getRepository(HallFloorVersionEntity).insert({
      hallId: hall.id,
      version: number,
      floor: next.floor,
      source: next.source,
      sourceRef: next.sourceRef ?? null,
      note: next.note ?? null,
      createdById: actor.id,
    });
    await em.getRepository(HallEntity).update(
      { id: hall.id },
      {
        currentVersion: number,
        width: next.floor.width,
        depth: next.floor.depth,
        floorArea: floorArea(next.floor),
      },
    );
    hall.currentVersion = number;
    return number;
  }

  async currentFloor(em: EntityManager, hall: HallEntity): Promise<HallFloor> {
    const row = await em
      .getRepository(HallFloorVersionEntity)
      .findOneByOrFail({ hallId: hall.id, version: hall.currentVersion });
    return row.floor;
  }

  async getHall(
    em: EntityManager,
    organisationId: string,
    hallId: string,
    lock = false,
  ): Promise<HallEntity> {
    const hall = await em.getRepository(HallEntity).findOne({
      where: { id: hallId, organisationId },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!hall) {
      throw new NotFoundException('There is no such hall in this organisation.');
    }
    return hall;
  }

  /** A hall an event uses keeps its floor history; remove it from the events first. */
  private async assertNotInEvents(em: EntityManager, halls: HallEntity[]): Promise<void> {
    const used = await em
      .getRepository(EventHallEntity)
      .createQueryBuilder('eh')
      .innerJoin('eh.event', 'event')
      .select(['eh.hallId AS "hallId"', 'event.name AS "eventName"'])
      .where('eh.hallId IN (:...ids)', { ids: halls.map((h) => h.id) })
      .orderBy('event.startsOn', 'ASC')
      .getRawOne<{ hallId: string; eventName: string }>();
    if (used) {
      const hall = halls.find((h) => h.id === used.hallId);
      throw new ConflictException(
        `${hall?.name ?? 'A hall'} is used by the event "${used.eventName}". Remove it from the event first.`,
      );
    }
  }

  async getVenue(em: EntityManager, organisationId: string, venueId: string): Promise<VenueEntity> {
    const venue = await em.getRepository(VenueEntity).findOneBy({ id: venueId, organisationId });
    if (!venue) {
      throw new NotFoundException('There is no such venue in this organisation.');
    }
    return venue;
  }

  async assertNameFree(
    em: EntityManager,
    venueId: string,
    name: string,
    exceptHallId?: string,
  ): Promise<void> {
    const clash = await em
      .getRepository(HallEntity)
      .createQueryBuilder('hall')
      .where('hall.venueId = :venueId', { venueId })
      .andWhere('lower(hall.name) = lower(:name)', { name })
      .andWhere(exceptHallId ? 'hall.id <> :exceptHallId' : 'true', { exceptHallId })
      .getOne();
    if (clash) {
      throw new ConflictException(`This venue already has a hall called "${clash.name}".`);
    }
  }

  async views(em: EntityManager, halls: HallEntity[]): Promise<HallView[]> {
    const refs = halls.length
      ? await em.getRepository(ExternalRefEntity).findBy({
          entityType: 'hall',
          localId: In(halls.map((h) => h.id)),
        })
      : [];
    const sources = new Map<string, HallSourceView>(
      refs.map((ref) => [ref.localId, { system: ref.system, externalId: ref.externalId }]),
    );
    return halls.map((hall) => ({
      id: hall.id,
      venueId: hall.venueId,
      name: hall.name,
      code: hall.code,
      level: hall.level,
      uses: hall.uses,
      width: hall.width,
      depth: hall.depth,
      floorArea: hall.floorArea,
      currentVersion: hall.currentVersion,
      source: sources.get(hall.id) ?? null,
      updatedAt: hall.updatedAt.toISOString(),
    }));
  }

  static versionView(row: HallFloorVersionEntity, current: number): FloorVersionView {
    return {
      version: row.version,
      source: row.source,
      sourceRef: row.sourceRef,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
      current: row.version === current,
    };
  }

  private static assertFloor(floor: HallFloor): void {
    const problems = floorProblems(floor);
    if (problems.length) {
      throw new BadRequestException(problems.join(' '));
    }
  }

  /** Only the uses that are on, so a stored hall says nothing it was not told. */
  private static uses(uses: HallUses): HallUses {
    return Object.fromEntries(
      (['fnb', 'branding', 'horseshoe', 'openArea'] as const)
        .filter((key) => uses[key] === true)
        .map((key) => [key, true]),
    );
  }
}
