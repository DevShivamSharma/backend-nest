import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/http/authenticated-request';
import type { OrganisationEntity } from '../organisations/organisation.entity';
import { CreateVenueDto, UpdateVenueDto } from './dto/venue.dto';
import { HallEntity } from './hall.entity';
import { HallsService } from './halls.service';
import { VenueEntity } from './venue.entity';
import type { VenueView } from './venue.views';

/** An organisation's venues. How many it may have is a limit the Super Admin sets. */
@Injectable()
export class VenuesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly halls: HallsService,
    private readonly audit: AuditService,
  ) {}

  async list(organisationId: string): Promise<VenueView[]> {
    const venues = await this.dataSource.getRepository(VenueEntity).find({
      where: { organisationId },
      order: { name: 'ASC' },
    });
    const counts = await this.hallCounts(this.dataSource.manager, organisationId);
    return venues.map((venue) => VenuesService.view(venue, counts.get(venue.id) ?? 0));
  }

  async get(organisationId: string, venueId: string): Promise<VenueView> {
    const em = this.dataSource.manager;
    const venue = await this.halls.getVenue(em, organisationId, venueId);
    const counts = await this.hallCounts(em, organisationId);
    return VenuesService.view(venue, counts.get(venue.id) ?? 0);
  }

  async create(
    organisation: OrganisationEntity,
    dto: CreateVenueDto,
    actor: Actor,
  ): Promise<VenueView> {
    const venue = await this.dataSource.transaction(async (em) => {
      const count = await em.getRepository(VenueEntity).countBy({
        organisationId: organisation.id,
      });
      if (count >= organisation.limits.venues) {
        throw new ConflictException(
          `${organisation.name} may have ${organisation.limits.venues} venue(s). ` +
            'The platform administrator can raise the limit.',
        );
      }
      await this.assertNameFree(em, organisation.id, dto.name);
      const venue = await em.getRepository(VenueEntity).save(
        em.getRepository(VenueEntity).create({
          organisationId: organisation.id,
          name: dto.name,
          code: dto.code ?? null,
          address: dto.address ?? null,
        }),
      );
      await this.audit.record(
        {
          action: 'venue.created',
          actor,
          organisationId: organisation.id,
          targetType: 'venue',
          targetId: venue.id,
          metadata: { name: venue.name },
        },
        em,
      );
      return venue;
    });
    return VenuesService.view(venue, 0);
  }

  async update(
    organisationId: string,
    venueId: string,
    dto: UpdateVenueDto,
    actor: Actor,
  ): Promise<VenueView> {
    await this.dataSource.transaction(async (em) => {
      const venue = await this.halls.getVenue(em, organisationId, venueId);
      if (dto.name !== undefined && dto.name !== venue.name) {
        await this.assertNameFree(em, organisationId, dto.name, venue.id);
        venue.name = dto.name;
      }
      if (dto.code !== undefined) venue.code = dto.code ?? null;
      if (dto.address !== undefined) venue.address = dto.address ?? null;
      await em.getRepository(VenueEntity).save(venue);
      await this.audit.record(
        {
          action: 'venue.updated',
          actor,
          organisationId,
          targetType: 'venue',
          targetId: venue.id,
          metadata: { name: venue.name },
        },
        em,
      );
    });
    return this.get(organisationId, venueId);
  }

  /** Only an empty venue can go: its halls carry history that must not vanish by accident. */
  async remove(organisationId: string, venueId: string, actor: Actor): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const venue = await this.halls.getVenue(em, organisationId, venueId);
      const halls = await em.getRepository(HallEntity).countBy({ venueId });
      if (halls > 0) {
        throw new ConflictException(`${venue.name} still has ${halls} hall(s). Delete them first.`);
      }
      await em.getRepository(VenueEntity).delete({ id: venue.id });
      await this.audit.record(
        {
          action: 'venue.deleted',
          actor,
          organisationId,
          targetType: 'venue',
          targetId: venue.id,
          metadata: { name: venue.name },
        },
        em,
      );
    });
  }

  private async hallCounts(
    em: EntityManager,
    organisationId: string,
  ): Promise<Map<string, number>> {
    const rows: { venue_id: string; count: number }[] = await em
      .getRepository(HallEntity)
      .createQueryBuilder('hall')
      .select('hall.venue_id', 'venue_id')
      .addSelect('COUNT(*)::int', 'count')
      .where('hall.organisation_id = :organisationId', { organisationId })
      .groupBy('hall.venue_id')
      .getRawMany();
    return new Map(rows.map((row) => [row.venue_id, Number(row.count)]));
  }

  private async assertNameFree(
    em: EntityManager,
    organisationId: string,
    name: string,
    exceptVenueId?: string,
  ): Promise<void> {
    const clash = await em
      .getRepository(VenueEntity)
      .createQueryBuilder('venue')
      .where('venue.organisationId = :organisationId', { organisationId })
      .andWhere('lower(venue.name) = lower(:name)', { name })
      .andWhere(exceptVenueId ? 'venue.id <> :exceptVenueId' : 'true', { exceptVenueId })
      .getOne();
    if (clash) {
      throw new ConflictException(`There is already a venue called "${clash.name}".`);
    }
  }

  private static view(venue: VenueEntity, hallCount: number): VenueView {
    return {
      id: venue.id,
      name: venue.name,
      code: venue.code,
      address: venue.address,
      hallCount,
      createdAt: venue.createdAt.toISOString(),
    };
  }
}
