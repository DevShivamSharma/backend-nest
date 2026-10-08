import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor, OrgAccessContext } from '../common/http/authenticated-request';
import { EventEntity, EventStatus } from '../events/event.entity';
import { scopedEventIds } from '../events/event-rules';
import { EventsService } from '../events/events.service';
import { ExhibitorEntity } from '../exhibitors/exhibitor.entity';
import { ExhibitorsService } from '../exhibitors/exhibitors.service';
import { selfcareBooking, SelfcareBookingPayload } from '../integrations/itpo/selfcare-booking';
import type { StallSide } from '../rules/rule-engine';
import { StallEntity, StallPlanEntity, StallType } from '../stall-plans/stall-plan.entity';
import { StallPlansService } from '../stall-plans/stall-plans.service';
import { HallsService } from '../venues/halls.service';
import {
  ACTIVE_BOOKING_STATUSES,
  BookingChannel,
  BookingEntity,
  BookingStatus,
  PaymentStatus,
} from './booking.entity';
import { initialPaymentStatus, isActive, portalClosedReason } from './booking-rules';
import type { BookingView, MapStallView, PortalView, StallMapView } from './booking.views';
import {
  CreateBookingDto,
  ListBookingsQuery,
  PortalBookingDto,
  SelfcareRowDto,
} from './dto/booking.dto';

interface BookingRow {
  id: string;
  event_id: string;
  event_name: string;
  event_status: EventStatus;
  hall_id: string;
  hall_name: string;
  stall_id: string;
  stall_number: string;
  width: number;
  depth: number;
  open_sides: StallSide[];
  stall_type: StallType | null;
  exhibitor_id: string;
  exhibitor_name: string;
  channel: BookingChannel;
  status: BookingStatus;
  payment_status: PaymentStatus | null;
  note: string | null;
  external_ref: string | null;
  cancel_reason: string | null;
  created_at: Date;
  confirmed_at: Date | null;
  cancelled_at: Date | null;
  updated_at: Date;
}

interface BookingFilter {
  bookingId?: string;
  eventId?: string;
  exhibitorId?: string;
  status?: BookingStatus;
}

/**
 * Stall bookings. Staff holding `bookings.manage` book stalls for registered exhibitors
 * (internal), hold or confirm them, move and cancel them. An exhibitor's own users hold stalls
 * through the portal (external) when the organisation allows it, and cancel their own holds.
 * Only stalls of published plans of scheduled events are booked; a stall has at most one held
 * or confirmed booking. Nothing here takes or records a payment: see `venueReport`.
 */
@Injectable()
export class BookingsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly exhibitors: ExhibitorsService,
    private readonly plans: StallPlansService,
    private readonly halls: HallsService,
    private readonly audit: AuditService,
  ) {}

  // ---- staff ---------------------------------------------------------------------------------

  async list(access: OrgAccessContext, query: ListBookingsQuery = {}): Promise<BookingView[]> {
    if (query.eventId) await this.events.getEvent(this.dataSource.manager, access, query.eventId);
    return this.find(access, query);
  }

  async get(access: OrgAccessContext, bookingId: string): Promise<BookingView> {
    const [booking] = await this.find(access, { bookingId });
    if (!booking) throw new NotFoundException('There is no such booking.');
    return booking;
  }

  /** A published hall plan of the event and which of its stalls are free, as staff see it. */
  stallMap(access: OrgAccessContext, eventId: string, hallId: string): Promise<StallMapView> {
    return this.map(access, eventId, hallId, null);
  }

  /** Books a stall for a registered exhibitor: held, or confirmed at once. */
  async create(
    access: OrgAccessContext,
    dto: CreateBookingDto,
    actor: Actor,
  ): Promise<BookingView> {
    const id = await this.dataSource.transaction(async (em) => {
      const event = await this.openEvent(em, access, dto.eventId);
      BookingsService.assertBookable(event);
      const exhibitor = await this.exhibitors.getOwn(em, access.organisation.id, dto.exhibitorId);
      if (!(await this.exhibitors.isRegistered(em, event.id, exhibitor.id))) {
        throw new ConflictException(`Register ${exhibitor.name} for ${event.name} first.`);
      }
      const booking = await this.insert(em, access, event, exhibitor, {
        stallId: dto.stallId,
        channel: 'internal',
        status: dto.confirm ? 'confirmed' : 'held',
        note: dto.note ?? null,
        actor,
      });
      return booking.id;
    });
    return this.get(access, id);
  }

  /** A held booking becomes confirmed. Payment, when tracked, stays as the venue reported it. */
  async confirm(access: OrgAccessContext, bookingId: string, actor: Actor): Promise<BookingView> {
    await this.change(access, bookingId, actor, (booking, event) => {
      if (booking.status !== 'held') {
        throw new ConflictException(
          `Only a held booking is confirmed; this one is ${booking.status}.`,
        );
      }
      BookingsService.assertBookable(event);
      booking.status = 'confirmed';
      booking.confirmedById = actor.id;
      booking.confirmedAt = new Date();
      return { action: 'booking.confirmed' };
    });
    return this.get(access, bookingId);
  }

  async cancel(
    access: OrgAccessContext,
    bookingId: string,
    reason: string,
    actor: Actor,
  ): Promise<BookingView> {
    await this.change(access, bookingId, actor, (booking, event) => {
      if (!isActive(booking.status)) {
        throw new ConflictException(`The booking is already ${booking.status}.`);
      }
      EventsService.assertOpen(event);
      BookingsService.markCancelled(booking, reason, actor);
      return { action: 'booking.cancelled', metadata: { reason } };
    });
    return this.get(access, bookingId);
  }

  /** Moves a held or confirmed booking to another free stall of the same event. */
  async move(
    access: OrgAccessContext,
    bookingId: string,
    stallId: string,
    actor: Actor,
  ): Promise<BookingView> {
    await this.change(access, bookingId, actor, async (booking, event, em) => {
      if (!isActive(booking.status)) {
        const article = booking.status === 'expired' ? 'An' : 'A';
        throw new ConflictException(`${article} ${booking.status} booking cannot move.`);
      }
      BookingsService.assertBookable(event);
      if (booking.stallId === stallId) {
        throw new ConflictException('The booking is already on this stall.');
      }
      const from = await em.getRepository(StallEntity).findOneByOrFail({ id: booking.stallId });
      const to = await this.lockFreeStall(em, event.id, stallId);
      booking.stallId = to.id;
      return { action: 'booking.moved', metadata: { from: from.number, to: to.number } };
    });
    return this.get(access, bookingId);
  }

  /**
   * The booking as rows of ITPO SelfCare's database, to be written there: SelfCare holds the
   * stall and takes the payment. Only a held booking is sent, in SelfCare's pre-payment state.
   * Prices and SelfCare's own ids come with the request; nothing is stored or sent from here.
   */
  async selfcareRow(
    access: OrgAccessContext,
    bookingId: string,
    dto: SelfcareRowDto,
  ): Promise<SelfcareBookingPayload> {
    const booking = await this.get(access, bookingId);
    if (booking.status !== 'held') {
      throw new ConflictException(
        `Only a held booking goes to SelfCare for payment; this one is ${booking.status}.`,
      );
    }
    // Prices left out are null, not undefined: the builder prices only a non-null rate.
    const p = dto.pricing;
    const t = dto.tax;
    return selfcareBooking(
      {
        name: booking.stall.number,
        area: booking.stall.area,
        openSides: booking.stall.openSides.length,
      },
      {
        user_id: dto.user_id ?? null,
        event_id: dto.event_id ?? null,
        event_name: booking.event.name,
        event_hall_id: dto.event_hall_id ?? null,
        hall_id: dto.hall_id ?? null,
        stall_id: dto.stall_id ?? null,
        stall_type: booking.stall.stallType,
        product_category_id: dto.product_category_id ?? null,
        pricing: p
          ? {
              bare_rate: p.bare_rate ?? null,
              shell_rate: p.shell_rate ?? null,
              two_side_open_rate_percent: p.two_side_open_rate_percent ?? null,
              three_side_open_rate_percent: p.three_side_open_rate_percent ?? null,
              four_side_open_rate_percent: p.four_side_open_rate_percent ?? null,
              catlog_entry_charge: p.catlog_entry_charge ?? null,
              corner_charges_applicable: p.corner_charges_applicable,
            }
          : null,
        tax: t
          ? {
              cgst_percent: t.cgst_percent ?? null,
              sgst_percent: t.sgst_percent ?? null,
              igst_percent: t.igst_percent ?? null,
            }
          : null,
      },
    );
  }

  // ---- exhibitor portal ------------------------------------------------------------------------

  /** The exhibitor's company, the events it is registered for, and whether it can book now. */
  async portal(access: OrgAccessContext): Promise<PortalView> {
    const em = this.dataSource.manager;
    const exhibitor = await this.portalExhibitor(em, access);
    const scope = scopedEventIds(access) ?? [];
    const events = scope.length
      ? await em
          .getRepository(EventEntity)
          .createQueryBuilder('event')
          .innerJoinAndSelect('event.venue', 'venue')
          .innerJoin(
            'event_exhibitors',
            'ee',
            'ee.event_id = event.id AND ee.exhibitor_id = :exhibitorId',
            { exhibitorId: exhibitor.id },
          )
          .where('event.organisationId = :organisationId', {
            organisationId: access.organisation.id,
          })
          .andWhere('event.id IN (:...ids)', { ids: scope })
          .orderBy('event.startsOn', 'ASC')
          .getMany()
      : [];
    const halls: {
      event_id: string;
      hall_id: string;
      name: string;
      published: boolean;
      free_stalls: number;
    }[] = events.length
      ? await em.query(
          `SELECT eh.event_id, eh.hall_id, h.name,
                  COALESCE(sp.status = 'published', false) AS published,
                  (SELECT count(*)::int FROM stalls s
                    WHERE s.plan_id = sp.id AND sp.status = 'published'
                      AND NOT EXISTS (SELECT 1 FROM bookings b
                                       WHERE b.stall_id = s.id
                                         AND b.status IN ('held', 'confirmed'))) AS free_stalls
             FROM event_halls eh
             JOIN halls h ON h.id = eh.hall_id
             LEFT JOIN stall_plans sp ON sp.event_id = eh.event_id AND sp.hall_id = eh.hall_id
            WHERE eh.event_id = ANY($1::uuid[])
            ORDER BY h.name`,
          [events.map((e) => e.id)],
        )
      : [];
    return {
      exhibitor: { id: exhibitor.id, name: exhibitor.name },
      bookingMode: access.organisation.bookingMode,
      closedReason: portalClosedReason(access.organisation),
      events: events.map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        startsOn: e.startsOn,
        endsOn: e.endsOn,
        venue: e.venue?.name ?? '',
        halls: halls
          .filter((h) => h.event_id === e.id)
          .map((h) => ({
            hallId: h.hall_id,
            name: h.name,
            published: h.published,
            freeStalls: h.free_stalls,
          })),
      })),
    };
  }

  async portalStallMap(
    access: OrgAccessContext,
    eventId: string,
    hallId: string,
  ): Promise<StallMapView> {
    const em = this.dataSource.manager;
    const exhibitor = await this.portalExhibitor(em, access);
    const event = await this.events.getEvent(em, access, eventId);
    await this.assertRegistered(em, event, exhibitor);
    return this.map(access, eventId, hallId, exhibitor);
  }

  async portalList(access: OrgAccessContext): Promise<BookingView[]> {
    const exhibitor = await this.portalExhibitor(this.dataSource.manager, access);
    return this.find(access, { exhibitorId: exhibitor.id });
  }

  /** The exhibitor holds a free stall for itself. Staff confirm it, or the venue system does. */
  async portalHold(
    access: OrgAccessContext,
    dto: PortalBookingDto,
    actor: Actor,
  ): Promise<BookingView> {
    const closed = portalClosedReason(access.organisation);
    if (closed) throw new ForbiddenException(closed);
    const id = await this.dataSource.transaction(async (em) => {
      const exhibitor = await this.portalExhibitor(em, access);
      const event = await this.openEvent(em, access, dto.eventId);
      await this.assertRegistered(em, event, exhibitor);
      BookingsService.assertBookable(event);
      const booking = await this.insert(em, access, event, exhibitor, {
        stallId: dto.stallId,
        channel: 'external',
        status: 'held',
        note: dto.note ?? null,
        actor,
      });
      return booking.id;
    });
    return this.get(access, id);
  }

  /** An exhibitor lets go of its own hold. A confirmed booking is cancelled by the organiser. */
  async portalCancel(
    access: OrgAccessContext,
    bookingId: string,
    reason: string | null,
    actor: Actor,
  ): Promise<BookingView> {
    const exhibitor = await this.portalExhibitor(this.dataSource.manager, access);
    await this.change(access, bookingId, actor, (booking, event) => {
      if (booking.exhibitorId !== exhibitor.id) {
        throw new NotFoundException('There is no such booking.');
      }
      if (booking.status !== 'held') {
        throw new ConflictException(
          booking.status === 'confirmed'
            ? 'A confirmed booking is cancelled by the organiser. Contact them.'
            : `The booking is already ${booking.status}.`,
        );
      }
      EventsService.assertOpen(event);
      BookingsService.markCancelled(booking, reason, actor);
      return { action: 'booking.cancelled', metadata: { reason, by: 'exhibitor' } };
    });
    return this.get(access, bookingId);
  }

  // ---- helpers ---------------------------------------------------------------------------------

  /**
   * The event, visible to the member, share-locked: bookings of one event go ahead side by side,
   * while a status change of the event waits for them (and they for it).
   */
  private async openEvent(
    em: EntityManager,
    access: OrgAccessContext,
    eventId: string,
  ): Promise<EventEntity> {
    await this.events.getEvent(em, access, eventId);
    return em.getRepository(EventEntity).findOneOrFail({
      where: { id: eventId },
      lock: { mode: 'pessimistic_read' },
    });
  }

  /** The member's exhibitor company, from its membership scope; 403 when it has none. */
  private async portalExhibitor(
    em: EntityManager,
    access: OrgAccessContext,
  ): Promise<ExhibitorEntity> {
    const exhibitorId = access.membership.scope?.exhibitorId;
    if (!exhibitorId || scopedEventIds(access) === null) {
      throw new ForbiddenException('Your membership is not linked to an exhibitor.');
    }
    return this.exhibitors.getOwn(em, access.organisation.id, exhibitorId);
  }

  private async assertRegistered(
    em: EntityManager,
    event: EventEntity,
    exhibitor: ExhibitorEntity,
  ): Promise<void> {
    if (!(await this.exhibitors.isRegistered(em, event.id, exhibitor.id))) {
      throw new ForbiddenException(`${exhibitor.name} is not registered for ${event.name}.`);
    }
  }

  /** A stall of a published plan of the event, row-locked, with no held or confirmed booking. */
  private async lockFreeStall(
    em: EntityManager,
    eventId: string,
    stallId: string,
  ): Promise<StallEntity> {
    const { stall, plan } = await this.plans.publishedStall(em, eventId, stallId);
    // Reopening the plan waits for this booking, and this booking for a reopening under way.
    const locked = await em.getRepository(StallPlanEntity).findOne({
      where: { id: plan.id },
      lock: { mode: 'pessimistic_read' },
    });
    if (locked?.status !== 'published') {
      throw new ConflictException(`Stall ${stall.number} is not open for booking yet.`);
    }
    await em.getRepository(StallEntity).findOne({
      where: { id: stall.id },
      lock: { mode: 'pessimistic_write' },
    });
    const active = await em.getRepository(BookingEntity).findOneBy({
      stallId: stall.id,
      status: In(ACTIVE_BOOKING_STATUSES),
    });
    if (active) {
      throw new ConflictException(
        `Stall ${stall.number} is already ${active.status === 'held' ? 'held' : 'booked'}.`,
      );
    }
    return stall;
  }

  private async insert(
    em: EntityManager,
    access: OrgAccessContext,
    event: EventEntity,
    exhibitor: ExhibitorEntity,
    input: {
      stallId: string;
      channel: BookingChannel;
      status: BookingStatus;
      note: string | null;
      actor: Actor;
    },
  ): Promise<BookingEntity> {
    const stall = await this.lockFreeStall(em, event.id, input.stallId);
    const now = new Date();
    const repo = em.getRepository(BookingEntity);
    const booking = await repo.save(
      repo.create({
        organisationId: access.organisation.id,
        eventId: event.id,
        stallId: stall.id,
        exhibitorId: exhibitor.id,
        channel: input.channel,
        status: input.status,
        paymentStatus: initialPaymentStatus(access.organisation.bookingMode, input.status),
        note: input.note,
        createdById: input.actor.id,
        confirmedById: input.status === 'confirmed' ? input.actor.id : null,
        confirmedAt: input.status === 'confirmed' ? now : null,
      }),
    );
    await this.audit.record(
      {
        action: input.status === 'confirmed' ? 'booking.confirmed' : 'booking.held',
        actor: input.actor,
        organisationId: access.organisation.id,
        targetType: 'booking',
        targetId: booking.id,
        metadata: {
          event: event.name,
          stall: stall.number,
          exhibitor: exhibitor.name,
          channel: input.channel,
        },
      },
      em,
    );
    return booking;
  }

  /** Runs one change on the locked booking, the member able to see its event, and records it. */
  private async change(
    access: OrgAccessContext,
    bookingId: string,
    actor: Actor,
    apply: (
      booking: BookingEntity,
      event: EventEntity,
      em: EntityManager,
    ) =>
      | { action: string; metadata?: Record<string, unknown> }
      | Promise<{ action: string; metadata?: Record<string, unknown> }>,
  ): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(BookingEntity);
      const found = await repo.findOneBy({ id: bookingId, organisationId: access.organisation.id });
      if (!found) throw new NotFoundException('There is no such booking.');
      const event = await this.openEvent(em, access, found.eventId);
      const booking = await repo.findOneOrFail({
        where: { id: bookingId },
        lock: { mode: 'pessimistic_write' },
      });
      const from = booking.status;
      const { action, metadata } = await apply(booking, event, em);
      await repo.save(booking);
      await this.audit.record(
        {
          action,
          actor,
          organisationId: access.organisation.id,
          targetType: 'booking',
          targetId: booking.id,
          metadata: { event: event.name, from, to: booking.status, ...metadata },
        },
        em,
      );
    });
  }

  private async map(
    access: OrgAccessContext,
    eventId: string,
    hallId: string,
    viewer: ExhibitorEntity | null,
  ): Promise<StallMapView> {
    const em = this.dataSource.manager;
    const event = await this.events.getEvent(em, access, eventId);
    const { link, hall } = await this.events.getEventHall(em, event, hallId);
    const plan = await em.getRepository(StallPlanEntity).findOneBy({ eventId, hallId });
    if (plan?.status !== 'published') {
      throw new NotFoundException('No stall plan has been published for this hall yet.');
    }
    const stalls = await em.getRepository(StallEntity).find({
      where: { planId: plan.id },
      order: { number: 'ASC' },
    });
    const active: {
      id: string;
      stall_id: string;
      status: BookingStatus;
      exhibitor_id: string;
      exhibitor_name: string;
    }[] = await em.query(
      `SELECT b.id, b.stall_id, b.status, b.exhibitor_id, x.name AS exhibitor_name
         FROM bookings b
         JOIN stalls s ON s.id = b.stall_id
         JOIN exhibitors x ON x.id = b.exhibitor_id
        WHERE s.plan_id = $1 AND b.status IN ('held', 'confirmed')`,
      [plan.id],
    );
    const byStall = new Map(active.map((b) => [b.stall_id, b]));
    const { floor } = await this.halls.floorVersion(
      access.organisation.id,
      hallId,
      link.floorVersion,
    );
    const portalOpen = viewer ? portalClosedReason(access.organisation) === null : true;
    return {
      event: { id: event.id, name: event.name, status: event.status, eventType: event.eventType },
      hall: { id: hall.id, name: hall.name, floorVersion: link.floorVersion },
      bookable: event.status === 'scheduled' && portalOpen,
      floor,
      stalls: stalls.map((s): MapStallView => {
        const b = byStall.get(s.id);
        const own = !!viewer && b?.exhibitor_id === viewer.id;
        return {
          ...StallPlansService.stallView(s),
          state: !b ? 'free' : b.status === 'held' ? 'held' : 'booked',
          booking: b && (!viewer || own) ? { id: b.id, exhibitor: b.exhibitor_name, own } : null,
        };
      }),
    };
  }

  /** Bookings the member may see, newest first: event-scoped members only at their events. */
  private async find(access: OrgAccessContext, filter: BookingFilter): Promise<BookingView[]> {
    const params: unknown[] = [access.organisation.id];
    const where = ['b.organisation_id = $1'];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    const scope = scopedEventIds(access);
    if (scope !== null) add('b.event_id = ANY(?::uuid[])', scope);
    if (filter.bookingId) add('b.id = ?', filter.bookingId);
    if (filter.eventId) add('b.event_id = ?', filter.eventId);
    if (filter.exhibitorId) add('b.exhibitor_id = ?', filter.exhibitorId);
    if (filter.status) add('b.status = ?', filter.status);
    const rows: BookingRow[] = await this.dataSource.query(
      `SELECT b.id, b.event_id, e.name AS event_name, e.status AS event_status,
              h.id AS hall_id, h.name AS hall_name, s.id AS stall_id, s.number AS stall_number,
              s.width, s.depth, s.open_sides, s.stall_type,
              b.exhibitor_id, x.name AS exhibitor_name, b.channel, b.status, b.payment_status,
              b.note, b.external_ref, b.cancel_reason, b.created_at, b.confirmed_at,
              b.cancelled_at, b.updated_at
         FROM bookings b
         JOIN events e ON e.id = b.event_id
         JOIN stalls s ON s.id = b.stall_id
         JOIN stall_plans p ON p.id = s.plan_id
         JOIN halls h ON h.id = p.hall_id
         JOIN exhibitors x ON x.id = b.exhibitor_id
        WHERE ${where.join(' AND ')}
        ORDER BY b.created_at DESC, b.id`,
      params,
    );
    return rows.map(BookingsService.view);
  }

  private static view(r: BookingRow): BookingView {
    return {
      id: r.id,
      event: { id: r.event_id, name: r.event_name, status: r.event_status },
      hall: { id: r.hall_id, name: r.hall_name },
      stall: {
        id: r.stall_id,
        number: r.stall_number,
        area: Math.round(r.width * r.depth * 100) / 100,
        openSides: r.open_sides,
        stallType: r.stall_type,
      },
      exhibitor: { id: r.exhibitor_id, name: r.exhibitor_name },
      channel: r.channel,
      status: r.status,
      paymentStatus: r.payment_status,
      note: r.note,
      externalRef: r.external_ref,
      cancelReason: r.cancel_reason,
      createdAt: r.created_at.toISOString(),
      confirmedAt: r.confirmed_at?.toISOString() ?? null,
      cancelledAt: r.cancelled_at?.toISOString() ?? null,
      updatedAt: r.updated_at.toISOString(),
    };
  }

  /** Stalls are booked only while the event is scheduled. */
  private static assertBookable(event: EventEntity): void {
    if (event.status !== 'scheduled') {
      throw new ConflictException(
        `Stalls are booked once the event is scheduled; ${event.name} is ${event.status}.`,
      );
    }
  }

  private static markCancelled(booking: BookingEntity, reason: string | null, actor: Actor): void {
    booking.status = 'cancelled';
    booking.cancelledById = actor.id;
    booking.cancelledAt = new Date();
    booking.cancelReason = reason;
  }
}
