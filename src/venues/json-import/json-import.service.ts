import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { createHash } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import type { Actor } from '../../common/http/authenticated-request';
import { ExternalRefEntity } from '../../integrations/external-ref.entity';
import { HallEntity } from '../hall.entity';
import { HallsService } from '../halls.service';
import { countAreas, floorArea, sameFloor, HallFloor } from '../floor/hall-floor';
import { adaptJson, JsonRow } from './adapter';
import { adaptCsv } from './csv-adapter';
import { JsonFileDto, JsonImportDto } from './dto';
import type { ItpoImportResult } from '../venue.views';
@Injectable()
export class JsonHallImportService {
  constructor(
    @InjectDataSource() private db: DataSource,
    private halls: HallsService,
    private audit: AuditService,
  ) {}
  private read(dto: JsonFileDto) {
    try {
      return dto.format === 'csv'
        ? adaptCsv(dto.content, dto.mapping)
        : adaptJson(dto.content, dto.mapping);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Could not read the file.');
    }
  }
  private reference(row: JsonRow, venue: string) {
    return row.source === 'itpo'
      ? row.externalId
      : createHash('sha256').update(`${venue}:${row.externalId}`).digest('hex');
  }
  private async linked(em: EntityManager, org: string, venue: string, row: JsonRow) {
    const ref = await em.getRepository(ExternalRefEntity).findOneBy({
      organisationId: org,
      system: row.source,
      entityType: 'hall',
      externalId: this.reference(row, venue),
    });
    if (!ref) return null;
    const hall = await this.halls.getHall(em, org, ref.localId);
    return { hall, floor: await this.halls.currentFloor(em, hall) };
  }
  async preview(org: string, venue: string, dto: JsonFileDto) {
    await this.halls.getVenue(this.db.manager, org, venue);
    const adapted = this.read(dto),
      rows = [];
    for (const r of adapted.rows) {
      const existing = await this.linked(this.db.manager, org, venue, r);
      const floor = r.floor;
      rows.push({
        ...r,
        width: floor?.width ?? null,
        depth: floor?.depth ?? null,
        floorArea: floor ? floorArea(floor) : null,
        counts: floor ? countAreas(floor) : null,
        existing: existing
          ? {
              hallId: existing.hall.id,
              name: existing.hall.name,
              version: existing.hall.currentVersion,
              sameFloor: !!floor && sameFloor(existing.floor, floor),
            }
          : null,
        error:
          existing && existing.hall.venueId !== venue
            ? 'This source hall is already linked to another venue.'
            : r.error,
      });
    }
    const previewToken = createHash('sha256')
      .update(JSON.stringify({ org, venue, rows }))
      .digest('hex');
    return { ...adapted, rows, previewToken };
  }
  async import(
    org: string,
    venue: string,
    dto: JsonImportDto,
    actor: Actor,
  ): Promise<ItpoImportResult> {
    if (!dto.reviewed)
      throw new BadRequestException('Inspect the converted hall preview before saving.');
    const preview = await this.preview(org, venue, dto);
    if (preview.previewToken !== dto.previewToken)
      throw new ConflictException(
        'The file, mapping or saved hall changed. Preview it again before saving.',
      );
    const picked = new Set<string>();
    const choices = dto.halls.map((c) => {
      const r = preview.rows.find((r) => r.externalId === c.externalId);
      if (!r || !r.floor || r.error)
        throw new BadRequestException(r?.error ?? 'Selected hall is not available in this file.');
      if (picked.has(c.externalId)) throw new BadRequestException('A hall was selected twice.');
      picked.add(c.externalId);
      return { choice: c, row: r };
    });
    const result = await this.db.transaction(async (em) => {
      await this.halls.getVenue(em, org, venue);
      const created: HallEntity[] = [],
        updated: HallEntity[] = [],
        unchanged: HallEntity[] = [];
      for (const { choice, row } of choices) {
        const previous = await this.linked(em, org, venue, row);
        let hall: HallEntity;
        const floor = row.floor as HallFloor;
        if (previous) {
          hall = await this.halls.getHall(em, org, previous.hall.id, true);
          if (hall.currentVersion !== row.existing?.version)
            throw new ConflictException('A hall changed while importing. Preview the file again.');
          if (sameFloor(await this.halls.currentFloor(em, hall), floor)) {
            unchanged.push(hall);
            continue;
          }
          await this.halls.addVersion(
            em,
            hall,
            {
              floor,
              source: dto.format === 'csv' ? 'csv' : 'json',
              sourceRef: row.externalId,
              note: `Reimported from reviewed ${dto.format === 'csv' ? 'CSV' : 'JSON'}`,
            },
            actor,
          );
          updated.push(hall);
        } else {
          if (row.existing)
            throw new ConflictException(
              'The previously imported hall was removed. Preview the file again.',
            );
          hall = await this.halls.insertHall(
            em,
            {
              organisationId: org,
              venueId: venue,
              name: choice.name,
              code: choice.code,
              level: choice.level,
            },
            {
              floor,
              source: dto.format === 'csv' ? 'csv' : 'json',
              sourceRef: row.externalId,
              note: `Imported from reviewed ${dto.format === 'csv' ? 'CSV' : 'JSON'}`,
            },
            actor,
          );
          await em.getRepository(ExternalRefEntity).insert({
            organisationId: org,
            system: row.source,
            entityType: 'hall',
            localId: hall.id,
            externalId: this.reference(row, venue),
          });
          created.push(hall);
        }
        await this.audit.record(
          {
            action: dto.format === 'csv' ? 'hall.csv_imported' : 'hall.json_imported',
            actor,
            organisationId: org,
            targetType: 'hall',
            targetId: hall.id,
            metadata: { name: hall.name, externalId: row.externalId, source: row.source },
          },
          em,
        );
      }
      return { created, updated, unchanged };
    });
    const views = async (list: HallEntity[]) =>
      list.length
        ? this.halls.views(
            this.db.manager,
            await this.db.getRepository(HallEntity).findBy({ id: In(list.map((h) => h.id)) }),
          )
        : [];
    return {
      created: await views(result.created),
      updated: await views(result.updated),
      unchanged: await views(result.unchanged),
    };
  }
}
