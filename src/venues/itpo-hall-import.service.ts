import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/http/authenticated-request';
import { ExternalRefEntity } from '../integrations/external-ref.entity';
import {
  ItpoHallRow,
  itpoRowToFloor,
  readItpoHallRows,
} from '../integrations/itpo/itpo-hall-layout';
import { ItpoFileDto, ItpoImportDto } from './dto/venue.dto';
import { countAreas, floorArea, HallFloor, sameFloor } from './floor/hall-floor';
import { HallEntity, HallFloorVersionEntity } from './hall.entity';
import { HallsService } from './halls.service';
import { VenueEntity } from './venue.entity';
import type {
  HallView,
  ItpoImportPreview,
  ItpoImportResult,
  ItpoImportRowView,
} from './venue.views';

/**
 * Brings ITPO's hall floors in from an export of `T_HALL_LAYOUTS` (or of an event-hall's copy,
 * `T_EVENT_HALL_LAYOUT_DATA`). Nothing is read from ITPO's systems: the file is the input.
 *
 * Two steps. The preview converts every row and says what importing it would do; nothing is
 * saved. The import then saves the halls the person picked, with the names they gave. An ITPO
 * hall imported before is found through its external ref and gets a new floor version, never a
 * second hall.
 */
@Injectable()
export class ItpoHallImportService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly halls: HallsService,
    private readonly audit: AuditService,
  ) {}

  async preview(
    organisationId: string,
    venueId: string,
    dto: ItpoFileDto,
  ): Promise<ItpoImportPreview> {
    const em = this.dataSource.manager;
    await this.halls.getVenue(em, organisationId, venueId);
    const rows = this.read(dto);
    const linked = await this.linkedHalls(
      em,
      organisationId,
      rows.map((r) => r.hallId),
    );
    const seen = new Set<string>();

    const views: ItpoImportRowView[] = [];
    for (const row of rows) {
      const base: ItpoImportRowView = {
        externalId: row.hallId,
        layoutId: row.layoutId,
        name: row.name ?? `ITPO hall ${row.hallId}`,
        width: null,
        depth: null,
        floorArea: null,
        counts: null,
        labels: 0,
        iconGroups: 0,
        warnings: [],
        existing: null,
        error: null,
      };
      if (seen.has(row.hallId)) {
        views.push({ ...base, error: `Hall ${row.hallId} appears more than once in the file.` });
        continue;
      }
      seen.add(row.hallId);

      let floor: HallFloor;
      try {
        const result = itpoRowToFloor(row);
        floor = result.floor;
        base.warnings = result.warnings;
      } catch (error) {
        views.push({ ...base, error: (error as Error).message });
        continue;
      }

      const link = linked.get(row.hallId);
      views.push({
        ...base,
        width: floor.width,
        depth: floor.depth,
        floorArea: floorArea(floor),
        counts: countAreas(floor),
        labels: floor.labels.length,
        iconGroups: floor.iconGroups.length,
        existing: link
          ? {
              hallId: link.hall.id,
              name: link.hall.name,
              venueId: link.venue.id,
              venueName: link.venue.name,
              sameFloor: sameFloor(link.floor, floor),
            }
          : null,
        error:
          link && link.venue.id !== venueId
            ? `Already imported as "${link.hall.name}" in ${link.venue.name}.`
            : null,
      });
    }
    return { rows: views };
  }

  async import(
    organisationId: string,
    venueId: string,
    dto: ItpoImportDto,
    actor: Actor,
  ): Promise<ItpoImportResult> {
    if (!dto.halls.length) {
      throw new BadRequestException('Choose at least one hall to import.');
    }
    const rows = new Map(this.read(dto).map((row) => [row.hallId, row]));
    const picked = new Set<string>();
    for (const choice of dto.halls) {
      if (!rows.has(choice.externalId)) {
        throw new BadRequestException(`Hall ${choice.externalId} is not in the file.`);
      }
      if (picked.has(choice.externalId)) {
        throw new BadRequestException(`Hall ${choice.externalId} is chosen twice.`);
      }
      picked.add(choice.externalId);
    }

    const outcome = await this.dataSource.transaction(async (em) => {
      await this.halls.getVenue(em, organisationId, venueId);
      const created: HallEntity[] = [];
      const updated: HallEntity[] = [];
      const unchanged: HallEntity[] = [];

      for (const choice of dto.halls) {
        const row = rows.get(choice.externalId)!;
        let floor: HallFloor;
        try {
          floor = itpoRowToFloor(row).floor;
        } catch (error) {
          throw new BadRequestException((error as Error).message);
        }
        const sourceRef = ItpoHallImportService.sourceRef(row);
        const ref = await em.getRepository(ExternalRefEntity).findOneBy({
          organisationId,
          system: 'itpo',
          entityType: 'hall',
          externalId: row.hallId,
        });

        if (ref) {
          const hall = await this.halls.getHall(em, organisationId, ref.localId, true);
          if (hall.venueId !== venueId) {
            throw new BadRequestException(
              `ITPO hall ${row.hallId} is already imported as "${hall.name}" in another venue.`,
            );
          }
          if (sameFloor(await this.halls.currentFloor(em, hall), floor)) {
            unchanged.push(hall);
            continue;
          }
          const version = await this.halls.addVersion(
            em,
            hall,
            { floor, source: 'itpo', sourceRef, note: 'Imported again from ITPO' },
            actor,
          );
          await this.record(em, 'hall.floor_reimported', organisationId, hall, actor, {
            externalId: row.hallId,
            version,
          });
          updated.push(hall);
          continue;
        }

        const hall = await this.halls.insertHall(
          em,
          {
            organisationId,
            venueId,
            name: choice.name,
            code: choice.code,
            level: choice.level,
          },
          { floor, source: 'itpo', sourceRef, note: 'Imported from ITPO' },
          actor,
        );
        await em.getRepository(ExternalRefEntity).insert({
          organisationId,
          system: 'itpo',
          entityType: 'hall',
          localId: hall.id,
          externalId: row.hallId,
        });
        await this.record(em, 'hall.imported', organisationId, hall, actor, {
          externalId: row.hallId,
          system: 'itpo',
        });
        created.push(hall);
      }
      return { created, updated, unchanged };
    });

    const reload = async (list: HallEntity[]): Promise<HallView[]> =>
      list.length
        ? this.halls.views(
            this.dataSource.manager,
            await this.dataSource
              .getRepository(HallEntity)
              .find({ where: { id: In(list.map((h) => h.id)) }, order: { name: 'ASC' } }),
          )
        : [];
    return {
      created: await reload(outcome.created),
      updated: await reload(outcome.updated),
      unchanged: await reload(outcome.unchanged),
    };
  }

  private read(dto: ItpoFileDto): ItpoHallRow[] {
    try {
      return readItpoHallRows(dto.content, dto.format);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  /** The halls earlier imports made from these ITPO ids, with their venue and current floor. */
  private async linkedHalls(
    em: EntityManager,
    organisationId: string,
    externalIds: string[],
  ): Promise<Map<string, { hall: HallEntity; venue: VenueEntity; floor: HallFloor }>> {
    const refs = await em.getRepository(ExternalRefEntity).findBy({
      organisationId,
      system: 'itpo',
      entityType: 'hall',
      externalId: In(externalIds),
    });
    const linked = new Map<string, { hall: HallEntity; venue: VenueEntity; floor: HallFloor }>();
    for (const ref of refs) {
      const hall = await em
        .getRepository(HallEntity)
        .findOne({ where: { id: ref.localId }, relations: { venue: true } });
      if (!hall?.venue) continue;
      const current = await em
        .getRepository(HallFloorVersionEntity)
        .findOneByOrFail({ hallId: hall.id, version: hall.currentVersion });
      linked.set(ref.externalId, { hall, venue: hall.venue, floor: current.floor });
    }
    return linked;
  }

  private record(
    em: EntityManager,
    action: string,
    organisationId: string,
    hall: HallEntity,
    actor: Actor,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        actor,
        organisationId,
        targetType: 'hall',
        targetId: hall.id,
        metadata: { name: hall.name, version: hall.currentVersion, ...metadata },
      },
      em,
    );
  }

  private static sourceRef(row: ItpoHallRow): string {
    return row.layoutId
      ? `ITPO hall ${row.hallId}, layout row ${row.layoutId}`
      : `ITPO hall ${row.hallId}`;
  }
}
