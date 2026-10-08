import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor, OrgAccessContext } from '../common/http/authenticated-request';
import { HallEntity } from '../venues/hall.entity';
import { HallsService } from '../venues/halls.service';
import { VenueEntity } from '../venues/venue.entity';
import {
  ChangeEventStatusDto,
  CreateEventDto,
  ListEventsQuery,
  UpdateEventDto,
} from './dto/event.dto';
import { EventEntity, EventHallEntity } from './event.entity';
import { canMove, eventInScope, isOpen, isRealDay, scopedEventIds, today } from './event-rules';
import type { EventDetailView, EventHallView, EventView, HallOptionView } from './event.views';

interface Conflict {
  eventId: string;
  name: string;
  startsOn: string;
  endsOn: string;
}

/**
 * An organisation's events (Module D) and the halls they book. Whole-organisation members see
 * every event; event-scoped members only theirs. Creating events and booking halls is for
 * whole-organisation members.
 */
@Injectable()
export class EventsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly halls: HallsService,
    private readonly audit: AuditService,
  ) {}

  async list(access: OrgAccessContext, query: ListEventsQuery = {}): Promise<EventView[]> {
    const scoped = scopedEventIds(access);
    if (scoped && !scoped.length) return [];
    const qb = this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.venue', 'venue')
      .where('event.organisationId = :organisationId', {
        organisationId: access.organisation.id,
      });
    if (scoped) qb.andWhere('event.id IN (:...scoped)', { scoped });
    if (query.status) qb.andWhere('event.status = :status', { status: query.status });
    if (query.venueId) qb.andWhere('event.venueId = :venueId', { venueId: query.venueId });
    const events = await qb.orderBy('event.startsOn', 'DESC').addOrderBy('event.name').getMany();
    const counts = await this.hallCounts(
      this.dataSource.manager,
      events.map((e) => e.id),
    );
    return events.map((event) => EventsService.view(event, counts.get(event.id) ?? 0));
  }

  async get(access: OrgAccessContext, eventId: string): Promise<EventDetailView> {
    const em = this.dataSource.manager;
    return this.detail(em, await this.getEvent(em, access, eventId));
  }

  async create(access: OrgAccessContext, dto: CreateEventDto, actor: Actor): Promise<EventView> {
    EventsService.assertWholeOrganisation(access);
    EventsService.assertDays(dto.startsOn, dto.endsOn);
    const organisationId = access.organisation.id;
    const event = await this.dataSource.transaction(async (em) => {
      await this.halls.getVenue(em, organisationId, dto.venueId);
      if (dto.code) await this.assertCodeFree(em, organisationId, dto.code);
      const event = await em.getRepository(EventEntity).save(
        em.getRepository(EventEntity).create({
          organisationId,
          venueId: dto.venueId,
          name: dto.name,
          code: dto.code ?? null,
          kind: dto.kind,
          eventType: dto.eventType,
          status: 'draft',
          startsOn: dto.startsOn,
          endsOn: dto.endsOn,
          organiserName: dto.organiserName ?? null,
          organiserEmail: dto.organiserEmail ?? null,
          organiserPhone: dto.organiserPhone ?? null,
          description: dto.description ?? null,
          cancelledReason: null,
          createdById: actor.id,
        }),
      );
      await this.audit.record(
        {
          action: 'event.created',
          actor,
          organisationId,
          targetType: 'event',
          targetId: event.id,
          metadata: { name: event.name, startsOn: event.startsOn, endsOn: event.endsOn },
        },
        em,
      );
      return event;
    });
    return this.viewOf(this.dataSource.manager, event);
  }

  async update(
    access: OrgAccessContext,
    eventId: string,
    dto: UpdateEventDto,
    actor: Actor,
  ): Promise<EventView> {
    const organisationId = access.organisation.id;
    const event = await this.dataSource.transaction(async (em) => {
      const event = await this.getEvent(em, access, eventId, true);
      EventsService.assertOpen(event);
      const changed: string[] = [];

      if (dto.venueId !== undefined && dto.venueId !== event.venueId) {
        EventsService.assertWholeOrganisation(access);
        const halls = await em.getRepository(EventHallEntity).countBy({ eventId });
        if (halls) {
          throw new ConflictException(
            'The venue can change only while the event books no hall. Remove its halls first.',
          );
        }
        await this.halls.getVenue(em, organisationId, dto.venueId);
        event.venueId = dto.venueId;
        changed.push('venue');
      }

      const startsOn = dto.startsOn ?? event.startsOn;
      const endsOn = dto.endsOn ?? event.endsOn;
      if (startsOn !== event.startsOn || endsOn !== event.endsOn) {
        EventsService.assertDays(startsOn, endsOn);
        const halls = await em.getRepository(EventHallEntity).findBy({ eventId });
        // Lock the halls in a fixed order, then look for other events on the new days.
        await this.lockHalls(
          em,
          halls.map((h) => h.hallId),
        );
        for (const link of halls) {
          const conflicts = await this.conflicts(em, link.hallId, event.id, startsOn, endsOn);
          if (conflicts.length) {
            const hall = await em.getRepository(HallEntity).findOneByOrFail({ id: link.hallId });
            throw new ConflictException(EventsService.conflictMessage(hall.name, conflicts));
          }
        }
        event.startsOn = startsOn;
        event.endsOn = endsOn;
        changed.push('dates');
      }

      if (dto.eventType !== undefined && dto.eventType !== event.eventType) {
        const [{ count }] = await em.query(
          `SELECT count(*)::int AS count FROM stall_plans
            WHERE event_id = $1 AND status IN ('approved', 'published')`,
          [eventId],
        );
        if (count) {
          throw new ConflictException(
            'An approved or published stall plan was checked as ' +
              `${event.eventType}. Reopen its plans before changing the event type.`,
          );
        }
        event.eventType = dto.eventType;
        changed.push('eventType');
      }
      if (dto.code !== undefined && (dto.code ?? null) !== event.code) {
        if (dto.code) await this.assertCodeFree(em, organisationId, dto.code, event.id);
        event.code = dto.code ?? null;
        changed.push('code');
      }
      for (const key of [
        'name',
        'kind',
        'organiserName',
        'organiserEmail',
        'organiserPhone',
        'description',
      ] as const) {
        const value = dto[key];
        if (value !== undefined && value !== event[key]) {
          (event as unknown as Record<string, unknown>)[key] = value ?? null;
          changed.push(key);
        }
      }

      const saved = await em.getRepository(EventEntity).save(event);
      await this.audit.record(
        {
          action: 'event.updated',
          actor,
          organisationId,
          targetType: 'event',
          targetId: event.id,
          metadata: { name: saved.name, changed },
        },
        em,
      );
      return saved;
    });
    return this.viewOf(this.dataSource.manager, event);
  }

  async setStatus(
    access: OrgAccessContext,
    eventId: string,
    dto: ChangeEventStatusDto,
    actor: Actor,
  ): Promise<EventView> {
    const event = await this.dataSource.transaction(async (em) => {
      const event = await this.getEvent(em, access, eventId, true);
      const from = event.status;
      const to = dto.status;
      if (from === to) throw new BadRequestException(`The event is already ${to}.`);
      if (!canMove(from, to)) {
        throw new ConflictException(`An event cannot go from ${from} to ${to}.`);
      }
      if (to === 'draft' || to === 'cancelled') {
        const active = await this.activeBookings(em, eventId);
        if (active) {
          throw new ConflictException(
            `${event.name} has ${active} active booking(s). Cancel them first.`,
          );
        }
      }
      if (to === 'completed' && event.endsOn >= today()) {
        throw new ConflictException(
          `An event can be completed after its last day (${event.endsOn}).`,
        );
      }
      event.status = to;
      event.cancelledReason = to === 'cancelled' ? (dto.reason ?? null) : null;
      const saved = await em.getRepository(EventEntity).save(event);
      await this.audit.record(
        {
          action: 'event.status_changed',
          actor,
          organisationId: access.organisation.id,
          targetType: 'event',
          targetId: event.id,
          metadata: { name: event.name, from, to, reason: saved.cancelledReason },
        },
        em,
      );
      return saved;
    });
    return this.viewOf(this.dataSource.manager, event);
  }

  /** Only a draft without stall plans or bookings; anything further along is cancelled instead. */
  async remove(access: OrgAccessContext, eventId: string, actor: Actor): Promise<void> {
    EventsService.assertWholeOrganisation(access);
    await this.dataSource.transaction(async (em) => {
      const event = await this.getEvent(em, access, eventId, true);
      if (event.status !== 'draft') {
        throw new ConflictException('Only a draft event can be deleted. Cancel it instead.');
      }
      const [{ plans, bookings }] = await em.query(
        `SELECT (SELECT count(*)::int FROM stall_plans WHERE event_id = $1) AS plans,
                (SELECT count(*)::int FROM bookings WHERE event_id = $1) AS bookings`,
        [eventId],
      );
      if (plans || bookings) {
        throw new ConflictException(
          `${event.name} has stall plans or bookings. Cancel the event instead.`,
        );
      }
      await em.getRepository(EventEntity).delete({ id: event.id });
      await this.audit.record(
        {
          action: 'event.deleted',
          actor,
          organisationId: access.organisation.id,
          targetType: 'event',
          targetId: event.id,
          metadata: { name: event.name },
        },
        em,
      );
    });
  }

  /**
   * The halls of the event's venue, marked when booked here or by another event. For booking
   * halls, so for whole-organisation members: the conflicts name events outside a scope.
   */
  async hallOptions(access: OrgAccessContext, eventId: string): Promise<HallOptionView[]> {
    EventsService.assertWholeOrganisation(access);
    const em = this.dataSource.manager;
    const event = await this.getEvent(em, access, eventId);
    const halls = await em.getRepository(HallEntity).find({
      where: { organisationId: access.organisation.id, venueId: event.venueId },
      order: { name: 'ASC' },
    });
    const booked = new Set(
      (await em.getRepository(EventHallEntity).findBy({ eventId })).map((h) => h.hallId),
    );
    const options: HallOptionView[] = [];
    for (const hall of halls) {
      options.push({
        hallId: hall.id,
        name: hall.name,
        code: hall.code,
        booked: booked.has(hall.id),
        conflicts: await this.conflicts(em, hall.id, event.id, event.startsOn, event.endsOn),
      });
    }
    return options;
  }

  /**
   * Books a hall of the event's venue for the event's days, on the hall's current floor. The
   * hall row is locked, so two events cannot take it at once.
   */
  async addHall(
    access: OrgAccessContext,
    eventId: string,
    hallId: string,
    actor: Actor,
  ): Promise<EventDetailView> {
    EventsService.assertWholeOrganisation(access);
    await this.dataSource.transaction(async (em) => {
      const event = await this.getEvent(em, access, eventId, true);
      EventsService.assertOpen(event);
      const hall = await this.halls.getHall(em, access.organisation.id, hallId, true);
      if (hall.venueId !== event.venueId) {
        throw new BadRequestException(`${hall.name} is in another venue.`);
      }
      const links = em.getRepository(EventHallEntity);
      if (await links.existsBy({ eventId, hallId })) return;
      const conflicts = await this.conflicts(em, hallId, eventId, event.startsOn, event.endsOn);
      if (conflicts.length) {
        throw new ConflictException(EventsService.conflictMessage(hall.name, conflicts));
      }
      await links.insert({ eventId, hallId, floorVersion: hall.currentVersion });
      await this.audit.record(
        {
          action: 'event.hall_added',
          actor,
          organisationId: access.organisation.id,
          targetType: 'event',
          targetId: event.id,
          metadata: { name: event.name, hall: hall.name, floorVersion: hall.currentVersion },
        },
        em,
      );
    });
    return this.get(access, eventId);
  }

  async removeHall(
    access: OrgAccessContext,
    eventId: string,
    hallId: string,
    actor: Actor,
  ): Promise<void> {
    EventsService.assertWholeOrganisation(access);
    await this.dataSource.transaction(async (em) => {
      const event = await this.getEvent(em, access, eventId, true);
      EventsService.assertOpen(event);
      const link = await em.getRepository(EventHallEntity).findOneBy({ eventId, hallId });
      if (!link) throw new NotFoundException('The event does not book this hall.');
      const [{ plans }] = await em.query(
        `SELECT count(*)::int AS plans FROM stall_plans WHERE event_id = $1 AND hall_id = $2`,
        [eventId, hallId],
      );
      if (plans) {
        throw new ConflictException('The hall has a stall plan. Delete the plan first.');
      }
      const hall = await em.getRepository(HallEntity).findOneByOrFail({ id: hallId });
      await em.getRepository(EventHallEntity).delete({ eventId, hallId });
      await this.audit.record(
        {
          action: 'event.hall_removed',
          actor,
          organisationId: access.organisation.id,
          targetType: 'event',
          targetId: event.id,
          metadata: { name: event.name, hall: hall.name },
        },
        em,
      );
    });
  }

  // --- building blocks, also used by the exhibitor, stall-plan and booking modules -----------

  /** The organisation's event when the member may see it; 404 otherwise, as for any id. */
  async getEvent(
    em: EntityManager,
    access: OrgAccessContext,
    eventId: string,
    lock = false,
  ): Promise<EventEntity> {
    const event = eventInScope(access, eventId)
      ? await em.getRepository(EventEntity).findOne({
          where: { id: eventId, organisationId: access.organisation.id },
          ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
        })
      : null;
    if (!event) throw new NotFoundException('There is no such event in this organisation.');
    return event;
  }

  /** A hall the event books, with the hall itself; 404 when it does not book it. */
  async getEventHall(
    em: EntityManager,
    event: EventEntity,
    hallId: string,
  ): Promise<{ link: EventHallEntity; hall: HallEntity }> {
    const link = await em.getRepository(EventHallEntity).findOneBy({ eventId: event.id, hallId });
    const hall = link ? await em.getRepository(HallEntity).findOneBy({ id: hallId }) : null;
    if (!link || !hall) throw new NotFoundException('The event does not book this hall.');
    return { link, hall };
  }

  /** The events the member may see, by id; unknown or out-of-scope ids are left out. */
  async visibleIds(access: OrgAccessContext, ids: readonly string[]): Promise<string[]> {
    const wanted = ids.filter((id) => eventInScope(access, id));
    if (!wanted.length) return [];
    const rows = await this.dataSource.getRepository(EventEntity).find({
      select: { id: true },
      where: { id: In(wanted), organisationId: access.organisation.id },
    });
    return rows.map((r) => r.id);
  }

  static assertWholeOrganisation(access: OrgAccessContext): void {
    if (scopedEventIds(access) !== null) {
      throw new ForbiddenException('Only members of the whole organisation can do this.');
    }
  }

  static assertOpen(event: EventEntity): void {
    if (!isOpen(event.status)) {
      throw new ConflictException(`A ${event.status} event cannot change.`);
    }
  }

  static view(event: EventEntity, hallCount: number): EventView {
    return {
      id: event.id,
      name: event.name,
      code: event.code,
      kind: event.kind,
      eventType: event.eventType,
      status: event.status,
      startsOn: event.startsOn,
      endsOn: event.endsOn,
      venue: { id: event.venueId, name: event.venue?.name ?? '' },
      organiser: {
        name: event.organiserName,
        email: event.organiserEmail,
        phone: event.organiserPhone,
      },
      description: event.description,
      cancelledReason: event.cancelledReason,
      hallCount,
      createdAt: event.createdAt.toISOString(),
      updatedAt: event.updatedAt.toISOString(),
    };
  }

  // --- helpers ----------------------------------------------------------------------------

  private async viewOf(em: EntityManager, event: EventEntity): Promise<EventView> {
    event.venue ??=
      (await em.getRepository(VenueEntity).findOneBy({ id: event.venueId })) ?? undefined;
    const counts = await this.hallCounts(em, [event.id]);
    return EventsService.view(event, counts.get(event.id) ?? 0);
  }

  private async detail(em: EntityManager, event: EventEntity): Promise<EventDetailView> {
    const links = await em.getRepository(EventHallEntity).find({
      where: { eventId: event.id },
      relations: { hall: true },
    });
    const halls: EventHallView[] = links
      .filter((link) => link.hall)
      .map((link) => ({
        hallId: link.hallId,
        name: link.hall!.name,
        code: link.hall!.code,
        level: link.hall!.level,
        width: link.hall!.width,
        depth: link.hall!.depth,
        floorArea: link.hall!.floorArea,
        floorVersion: link.floorVersion,
        currentVersion: link.hall!.currentVersion,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ...(await this.viewOf(em, event)), halls };
  }

  /** Other non-cancelled events holding the hall on any of the given days. */
  private async conflicts(
    em: EntityManager,
    hallId: string,
    eventId: string,
    startsOn: string,
    endsOn: string,
  ): Promise<Conflict[]> {
    const rows: { id: string; name: string; starts_on: string; ends_on: string }[] = await em.query(
      `SELECT e.id, e.name, e.starts_on::text AS starts_on, e.ends_on::text AS ends_on
           FROM event_halls eh JOIN events e ON e.id = eh.event_id
          WHERE eh.hall_id = $1 AND e.id <> $2 AND e.status <> 'cancelled'
            AND e.starts_on <= $4 AND e.ends_on >= $3
          ORDER BY e.starts_on`,
      [hallId, eventId, startsOn, endsOn],
    );
    return rows.map((r) => ({
      eventId: r.id,
      name: r.name,
      startsOn: r.starts_on,
      endsOn: r.ends_on,
    }));
  }

  private async lockHalls(em: EntityManager, hallIds: string[]): Promise<void> {
    if (!hallIds.length) return;
    await em.query(`SELECT id FROM halls WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [
      hallIds,
    ]);
  }

  private async activeBookings(em: EntityManager, eventId: string): Promise<number> {
    const [{ count }] = await em.query(
      `SELECT count(*)::int AS count FROM bookings
        WHERE event_id = $1 AND status IN ('held', 'confirmed')`,
      [eventId],
    );
    return count;
  }

  private async hallCounts(em: EntityManager, eventIds: string[]): Promise<Map<string, number>> {
    if (!eventIds.length) return new Map();
    const rows: { event_id: string; count: number }[] = await em
      .getRepository(EventHallEntity)
      .createQueryBuilder('link')
      .select('link.event_id', 'event_id')
      .addSelect('COUNT(*)::int', 'count')
      .where('link.event_id IN (:...eventIds)', { eventIds })
      .groupBy('link.event_id')
      .getRawMany();
    return new Map(rows.map((row) => [row.event_id, Number(row.count)]));
  }

  private async assertCodeFree(
    em: EntityManager,
    organisationId: string,
    code: string,
    exceptEventId?: string,
  ): Promise<void> {
    const clash = await em
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .where('event.organisationId = :organisationId', { organisationId })
      .andWhere('lower(event.code) = lower(:code)', { code })
      .andWhere(exceptEventId ? 'event.id <> :exceptEventId' : 'true', { exceptEventId })
      .getOne();
    if (clash) {
      throw new ConflictException(`The code ${code} is already used by ${clash.name}.`);
    }
  }

  private static assertDays(startsOn: string, endsOn: string): void {
    if (!isRealDay(startsOn) || !isRealDay(endsOn)) {
      throw new BadRequestException('Use real calendar days for the event dates.');
    }
    if (endsOn < startsOn) {
      throw new BadRequestException('The last day cannot be before the first day.');
    }
  }

  private static conflictMessage(hall: string, conflicts: Conflict[]): string {
    const list = conflicts.map((c) => `${c.name} (${c.startsOn} to ${c.endsOn})`).join(', ');
    return `${hall} is already booked on these days by ${list}.`;
  }
}
