import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor, OrgAccessContext } from '../common/http/authenticated-request';
import { scopedEventIds } from '../events/event-rules';
import { EventsService } from '../events/events.service';
import { CreateExhibitorDto, ListExhibitorsQuery, UpdateExhibitorDto } from './dto/exhibitor.dto';
import { EventExhibitorEntity, ExhibitorEntity } from './exhibitor.entity';
import type { ExhibitorView } from './exhibitor.views';

/**
 * The companies that take stalls, and the events they are registered for. Members of the whole
 * organisation see every exhibitor; event-scoped members only those registered for their events.
 */
@Injectable()
export class ExhibitorsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  async list(access: OrgAccessContext, query: ListExhibitorsQuery = {}): Promise<ExhibitorView[]> {
    const em = this.dataSource.manager;
    if (query.eventId) await this.events.getEvent(em, access, query.eventId);
    const scoped = scopedEventIds(access);
    const filter = query.eventId ? [query.eventId] : scoped;
    const qb = em
      .getRepository(ExhibitorEntity)
      .createQueryBuilder('exhibitor')
      .where('exhibitor.organisationId = :organisationId', {
        organisationId: access.organisation.id,
      });
    if (filter) {
      if (!filter.length) return [];
      qb.andWhere(
        'EXISTS (SELECT 1 FROM event_exhibitors ee WHERE ee.exhibitor_id = exhibitor.id AND ee.event_id IN (:...filter))',
        { filter },
      );
    }
    const exhibitors = await qb.orderBy('exhibitor.name').getMany();
    return this.views(em, access, exhibitors);
  }

  async get(access: OrgAccessContext, exhibitorId: string): Promise<ExhibitorView> {
    const em = this.dataSource.manager;
    const [view] = await this.views(em, access, [await this.getVisible(em, access, exhibitorId)]);
    return view;
  }

  async create(
    access: OrgAccessContext,
    dto: CreateExhibitorDto,
    actor: Actor,
  ): Promise<ExhibitorView> {
    const organisationId = access.organisation.id;
    const scoped = scopedEventIds(access);
    if (scoped && !dto.eventId) {
      throw new BadRequestException('Choose the event the new exhibitor takes part in.');
    }
    const exhibitor = await this.dataSource.transaction(async (em) => {
      const event = dto.eventId ? await this.events.getEvent(em, access, dto.eventId, true) : null;
      if (event) EventsService.assertOpen(event);
      await this.assertNameFree(em, organisationId, dto.name);
      const exhibitor = await em.getRepository(ExhibitorEntity).save(
        em.getRepository(ExhibitorEntity).create({
          organisationId,
          name: dto.name,
          contactName: dto.contactName ?? null,
          email: dto.email ?? null,
          phone: dto.phone ?? null,
          gstin: dto.gstin ?? null,
          address: dto.address ?? null,
        }),
      );
      if (event) {
        await em.getRepository(EventExhibitorEntity).insert({
          eventId: event.id,
          exhibitorId: exhibitor.id,
        });
      }
      await this.audit.record(
        {
          action: 'exhibitor.created',
          actor,
          organisationId,
          targetType: 'exhibitor',
          targetId: exhibitor.id,
          metadata: { name: exhibitor.name, ...(event ? { event: event.name } : {}) },
        },
        em,
      );
      return exhibitor;
    });
    return this.get(access, exhibitor.id);
  }

  async update(
    access: OrgAccessContext,
    exhibitorId: string,
    dto: UpdateExhibitorDto,
    actor: Actor,
  ): Promise<ExhibitorView> {
    const organisationId = access.organisation.id;
    await this.dataSource.transaction(async (em) => {
      const exhibitor = await this.getVisible(em, access, exhibitorId, true);
      const changed: string[] = [];
      if (dto.name !== undefined && dto.name !== exhibitor.name) {
        await this.assertNameFree(em, organisationId, dto.name, exhibitor.id);
        exhibitor.name = dto.name;
        changed.push('name');
      }
      for (const key of ['contactName', 'email', 'phone', 'gstin', 'address'] as const) {
        if (dto[key] !== undefined && (dto[key] ?? null) !== exhibitor[key]) {
          exhibitor[key] = dto[key] ?? null;
          changed.push(key);
        }
      }
      await em.getRepository(ExhibitorEntity).save(exhibitor);
      await this.audit.record(
        {
          action: 'exhibitor.updated',
          actor,
          organisationId,
          targetType: 'exhibitor',
          targetId: exhibitor.id,
          metadata: { name: exhibitor.name, changed },
        },
        em,
      );
    });
    return this.get(access, exhibitorId);
  }

  /** Only an exhibitor registered for no event: registrations carry its bookings. */
  async remove(access: OrgAccessContext, exhibitorId: string, actor: Actor): Promise<void> {
    EventsService.assertWholeOrganisation(access);
    await this.dataSource.transaction(async (em) => {
      const exhibitor = await this.getVisible(em, access, exhibitorId, true);
      const registrations = await em.getRepository(EventExhibitorEntity).countBy({ exhibitorId });
      if (registrations) {
        throw new ConflictException(
          `${exhibitor.name} is registered for ${registrations} event(s). Remove it from them first.`,
        );
      }
      await em.getRepository(ExhibitorEntity).delete({ id: exhibitor.id });
      await this.audit.record(
        {
          action: 'exhibitor.deleted',
          actor,
          organisationId: access.organisation.id,
          targetType: 'exhibitor',
          targetId: exhibitor.id,
          metadata: { name: exhibitor.name },
        },
        em,
      );
    });
  }

  async register(
    access: OrgAccessContext,
    eventId: string,
    exhibitorId: string,
    actor: Actor,
  ): Promise<ExhibitorView> {
    await this.dataSource.transaction(async (em) => {
      const event = await this.events.getEvent(em, access, eventId, true);
      EventsService.assertOpen(event);
      const exhibitor = await this.getOwn(em, access.organisation.id, exhibitorId);
      const links = em.getRepository(EventExhibitorEntity);
      if (await links.existsBy({ eventId, exhibitorId })) return;
      await links.insert({ eventId, exhibitorId });
      await this.audit.record(
        {
          action: 'exhibitor.registered',
          actor,
          organisationId: access.organisation.id,
          targetType: 'exhibitor',
          targetId: exhibitor.id,
          metadata: { name: exhibitor.name, event: event.name },
        },
        em,
      );
    });
    return this.get(access, exhibitorId);
  }

  /** Not while it has bookings for the event, active or past. */
  async unregister(
    access: OrgAccessContext,
    eventId: string,
    exhibitorId: string,
    actor: Actor,
  ): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const event = await this.events.getEvent(em, access, eventId, true);
      const exhibitor = await this.getOwn(em, access.organisation.id, exhibitorId);
      const link = await em.getRepository(EventExhibitorEntity).findOneBy({ eventId, exhibitorId });
      if (!link) throw new NotFoundException(`${exhibitor.name} is not registered for this event.`);
      const [{ count }] = await em.query(
        `SELECT count(*)::int AS count FROM bookings WHERE event_id = $1 AND exhibitor_id = $2`,
        [eventId, exhibitorId],
      );
      if (count) {
        throw new ConflictException(
          `${exhibitor.name} has ${count} booking(s) at ${event.name} and stays registered.`,
        );
      }
      await em.getRepository(EventExhibitorEntity).delete({ eventId, exhibitorId });
      await this.audit.record(
        {
          action: 'exhibitor.unregistered',
          actor,
          organisationId: access.organisation.id,
          targetType: 'exhibitor',
          targetId: exhibitor.id,
          metadata: { name: exhibitor.name, event: event.name },
        },
        em,
      );
    });
  }

  // --- building blocks, also used by bookings ----------------------------------------------

  /** The organisation's exhibitor, whoever asks; 404 for anything else. */
  async getOwn(
    em: EntityManager,
    organisationId: string,
    exhibitorId: string,
    lock = false,
  ): Promise<ExhibitorEntity> {
    const exhibitor = await em.getRepository(ExhibitorEntity).findOne({
      where: { id: exhibitorId, organisationId },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!exhibitor) throw new NotFoundException('There is no such exhibitor in this organisation.');
    return exhibitor;
  }

  async isRegistered(em: EntityManager, eventId: string, exhibitorId: string): Promise<boolean> {
    return em.getRepository(EventExhibitorEntity).existsBy({ eventId, exhibitorId });
  }

  // --- helpers ----------------------------------------------------------------------------

  /** The exhibitor when the member may see it: event-scoped members, at their events only. */
  private async getVisible(
    em: EntityManager,
    access: OrgAccessContext,
    exhibitorId: string,
    lock = false,
  ): Promise<ExhibitorEntity> {
    const exhibitor = await this.getOwn(em, access.organisation.id, exhibitorId, lock);
    const scoped = scopedEventIds(access);
    if (scoped) {
      const visible = scoped.length
        ? await em.getRepository(EventExhibitorEntity).existsBy({
            exhibitorId,
            eventId: In([...scoped]),
          })
        : false;
      if (!visible) throw new NotFoundException('There is no such exhibitor in this organisation.');
    }
    return exhibitor;
  }

  private async views(
    em: EntityManager,
    access: OrgAccessContext,
    exhibitors: ExhibitorEntity[],
  ): Promise<ExhibitorView[]> {
    const ids = exhibitors.map((e) => e.id);
    const links = ids.length
      ? await em.getRepository(EventExhibitorEntity).findBy({ exhibitorId: In(ids) })
      : [];
    const scoped = scopedEventIds(access);
    const events = new Map<string, string[]>();
    for (const link of links) {
      if (scoped && !scoped.includes(link.eventId)) continue;
      events.set(link.exhibitorId, [...(events.get(link.exhibitorId) ?? []), link.eventId]);
    }
    return exhibitors.map((e) => ({
      id: e.id,
      name: e.name,
      contactName: e.contactName,
      email: e.email,
      phone: e.phone,
      gstin: e.gstin,
      address: e.address,
      eventIds: events.get(e.id) ?? [],
      createdAt: e.createdAt.toISOString(),
    }));
  }

  private async assertNameFree(
    em: EntityManager,
    organisationId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await em
      .getRepository(ExhibitorEntity)
      .createQueryBuilder('exhibitor')
      .where('exhibitor.organisationId = :organisationId', { organisationId })
      .andWhere('lower(exhibitor.name) = lower(:name)', { name })
      .andWhere(exceptId ? 'exhibitor.id <> :exceptId' : 'true', { exceptId })
      .getOne();
    if (clash) {
      throw new ConflictException(`There is already an exhibitor called "${clash.name}".`);
    }
  }
}
