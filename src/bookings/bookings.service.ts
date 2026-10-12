import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor, OrgAccessContext } from '../common/http/authenticated-request';
import type { BookingsConfig } from '../config/configuration';
import { EventEntity, EventHallEntity, EventStatus } from '../events/event.entity';
import { EventsService } from '../events/events.service';
import { ExhibitorsService } from '../exhibitors/exhibitors.service';
import { expireOpenPayments } from '../payments/booking-payments';
import type { PaymentProvider, PaymentStatus } from '../payments/payment.entity';
import { stallLabel } from '../stall-plans/published-stalls';
import { PublishedStallEntity, StallPlanEntity } from '../stall-plans/stall-plan.entity';
import {
  ACTIVE_BOOKING_STATUSES,
  BookingChannel,
  BookingEntity,
  BookingStatus,
} from './booking.entity';
import {
  eventClosedReason,
  holdEnds,
  isActive,
  portalClosedReason,
  stallClosedReason,
  stallState,
} from './booking-rules';
import type { BookingView, PublishedStallView, StallMapView } from './booking.views';
import { CreateBookingDto, ListBookingsQuery, MoveBookingDto } from './dto/booking.dto';

/** A booking with what its view needs from other tables. */
interface BookingRow {
  id: string;
  event_id: string;
  event_name: string;
  event_status: EventStatus;
  hall_id: string;
  hall_name: string;
  stall_id: string;
  stall_label: string;
  exhibitor_id: string;
  exhibitor_name: string;
  channel: BookingChannel;
  status: BookingStatus;
  hold_expires_at: Date | null;
  amount_paise: number;
  currency: string;
  price_reckoning: string;
  note: string | null;
  cancel_reason: string | null;
  created_at: Date;
  confirmed_at: Date | null;
  cancelled_at: Date | null;
  updated_at: Date;
  pay_status: PaymentStatus | null;
  pay_provider: PaymentProvider | null;
  pay_order_id: string | null;
  pay_payment_id: string | null;
  pay_method: string | null;
  pay_amount_paise: string | null;
  pay_paid_at: Date | null;
  pay_refunded_paise: string | null;
  pay_refund_pending_paise: string | null;
}

interface BookingFilter {
  bookingId?: string;
  eventId?: string;
  exhibitorId?: string;
  status?: BookingStatus;
}

/** What one change to a booking records in the audit log. */
interface Change {
  action: string;
  metadata?: Record<string, unknown>;
}

/**
 * Stall bookings as staff work them (docs/15 §5.3; ported from `@feature/rules` and retargeted at
 * the published plan). Members with `bookings.manage` hold or book a stall of a published plan
 * for an exhibitor registered for the event, confirm a hold, move a booking to another stall and
 * cancel it. A stall is bookable when the event is scheduled and the stall is on the published
 * plan, for sale, priced and without an active booking; its price is copied onto the booking.
 * Nothing here takes a payment (`PaymentsService` does); a booking that leaves `held` or moves
 * only expires its open order.
 *
 * Locks are always taken in this order, so nothing waits in a circle: the event row (shared), the
 * booking row, the plan row (shared), the published stall row. A status change of the event takes
 * the event row for update, so it waits for bookings under way and they for it; a re-publish takes
 * the plan row for update, so it sees every booking made before it and none is made during it.
 */
@Injectable()
export class BookingsService {
  private readonly holdMinutes: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly exhibitors: ExhibitorsService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.holdMinutes = config.getOrThrow<BookingsConfig>('bookings').holdMinutes;
  }

  async list(access: OrgAccessContext, query: ListBookingsQuery = {}): Promise<BookingView[]> {
    if (query.eventId) await this.events.eventFor(this.dataSource.manager, access, query.eventId);
    return this.find(access, query);
  }

  async get(access: OrgAccessContext, bookingId: string): Promise<BookingView> {
    const [booking] = await this.find(access, { bookingId });
    if (!booking) throw new NotFoundException('There is no such booking.');
    return booking;
  }

  /** A hall's published stalls, which are free, and why they cannot be booked when they cannot. */
  async stallMap(access: OrgAccessContext, eventId: string, hallId: string): Promise<StallMapView> {
    const detail = await this.events.hall(access, eventId, hallId);
    const { event, row } = await this.events.eventHallOf(access, eventId, hallId);
    const em = this.dataSource.manager;
    const plan = await em.getRepository(StallPlanEntity).findOneBy({ eventHallId: row.id });
    const stalls = await em
      .getRepository(PublishedStallEntity)
      .find({ where: { eventHallId: row.id }, order: { stallNumber: 'ASC' } });
    const active: Array<{
      id: string;
      stall_id: string;
      status: BookingStatus;
      exhibitor_id: string;
      exhibitor: string;
    }> = await em.query(
      `SELECT b.id, b.stall_id, b.status, b.exhibitor_id, x.name AS exhibitor
           FROM bookings b JOIN exhibitors x ON x.id = b.exhibitor_id
          WHERE b.event_hall_id = $1 AND b.status IN ('held', 'confirmed')`,
      [row.id],
    );
    const byStall = new Map(active.map((b) => [b.stall_id, b]));
    const published =
      plan?.publishedRevision && plan.publishedAt
        ? { revision: plan.publishedRevision, at: plan.publishedAt.toISOString() }
        : null;
    const closedReason =
      eventClosedReason(event) ??
      (published ? null : `No stall plan of ${detail.hall.name} is published yet.`);
    return {
      event: { id: event.id, name: event.name, status: event.status },
      hall: { id: hallId, name: detail.hall.name, floorVersion: detail.hall.floorVersion },
      published,
      bookable: !closedReason,
      closedReason,
      floor: detail.floor,
      stalls: stalls.map((s) => {
        const b = byStall.get(s.stallId);
        return {
          ...BookingsService.stallView(s),
          state: stallState(s, b?.status ?? null),
          booking: b
            ? { id: b.id, exhibitorId: b.exhibitor_id, exhibitor: b.exhibitor, status: b.status }
            : null,
        };
      }),
    };
  }

  /** Books a stall for a registered exhibitor: held until confirmed, or confirmed at once. */
  async create(
    access: OrgAccessContext,
    dto: CreateBookingDto,
    actor: Actor,
    channel: BookingChannel = 'internal',
  ): Promise<BookingView> {
    const { event, row } = await this.events.eventHallOf(access, dto.eventId, dto.hallId);
    const id = await this.dataSource.transaction(async (em) => {
      const locked = await this.lockEvent(em, event.id);
      // The portal also needs the organisation's switch and the platform as the event's channel.
      const closed =
        channel === 'external'
          ? portalClosedReason(access.organisation, locked)
          : eventClosedReason(locked);
      if (closed) throw new ConflictException(closed);
      const exhibitor = await this.exhibitors.getOwn(em, access.organisation.id, dto.exhibitorId);
      if (!(await this.exhibitors.isRegistered(em, event.id, exhibitor.id))) {
        throw new ConflictException(`Register ${exhibitor.name} for ${event.name} first.`);
      }
      const stall = await this.lockFreeStall(em, row, dto.stallId);
      const now = new Date();
      // An exhibitor only holds; the payment (or the organiser) confirms.
      const confirm = channel === 'internal' && dto.confirm === true;
      const repo = em.getRepository(BookingEntity);
      const booking = await repo.save(
        repo.create({
          organisationId: access.organisation.id,
          eventId: event.id,
          eventHallId: row.id,
          stallId: stall.stallId,
          stallLabel: stallLabel(stall),
          exhibitorId: exhibitor.id,
          channel,
          status: confirm ? 'confirmed' : 'held',
          holdExpiresAt: confirm ? null : holdEnds(now, this.holdMinutes),
          // The price as published: a later rate card never changes what was agreed.
          amountPaise: stall.pricePaise!,
          currency: stall.currency!,
          priceReckoning: stall.priceReckoning!,
          note: dto.note ?? null,
          createdById: actor.id,
          confirmedAt: confirm ? now : null,
          confirmedById: confirm ? actor.id : null,
          cancelledAt: null,
          cancelledById: null,
          cancelReason: null,
        }),
      );
      await this.audit.record(
        {
          action: confirm ? 'booking.confirmed' : 'booking.held',
          actor,
          organisationId: access.organisation.id,
          targetType: 'booking',
          targetId: booking.id,
          metadata: {
            event: event.name,
            hall: row.hall?.name ?? null,
            stall: booking.stallLabel,
            exhibitor: exhibitor.name,
            amountPaise: booking.amountPaise,
            channel,
          },
        },
        em,
      );
      return booking.id;
    });
    return this.get(access, id);
  }

  /** A hold becomes a booking, while the event is on sale and the hold has not run out. */
  async confirm(access: OrgAccessContext, bookingId: string, actor: Actor): Promise<BookingView> {
    await this.change(access, bookingId, actor, async (booking, event, em) => {
      if (booking.status !== 'held') {
        throw new ConflictException(
          `Only a held booking is confirmed; this one is ${booking.status}.`,
        );
      }
      const closed = eventClosedReason(event);
      if (closed) throw new ConflictException(closed);
      // The worker marks it expired within a minute; until then it is not confirmed either.
      if (booking.holdExpiresAt && booking.holdExpiresAt <= new Date()) {
        throw new ConflictException(`The hold on stall ${booking.stallLabel} has run out.`);
      }
      Object.assign(booking, {
        status: 'confirmed',
        confirmedAt: new Date(),
        confirmedById: actor.id,
        holdExpiresAt: null,
      });
      // Confirmed by staff: an open order can no longer confirm it again (ruling 5).
      await expireOpenPayments(em, [booking.id]);
      return { action: 'booking.confirmed' };
    });
    return this.get(access, bookingId);
  }

  /** Cancels a held or confirmed booking of an event that still changes; the stall is free again. */
  async cancel(
    access: OrgAccessContext,
    bookingId: string,
    reason: string,
    actor: Actor,
  ): Promise<BookingView> {
    await this.change(access, bookingId, actor, async (booking, event, em) => {
      if (!isActive(booking.status)) {
        throw new ConflictException(`The booking is already ${booking.status}.`);
      }
      EventsService.assertOpen(event);
      Object.assign(booking, {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledById: actor.id,
        cancelReason: reason,
      });
      // A paid booking stays paid: staff refund it separately (docs/15 §6.2).
      await expireOpenPayments(em, [booking.id]);
      return { action: 'booking.cancelled', metadata: { reason } };
    });
    return this.get(access, bookingId);
  }

  /**
   * An exhibitor lets go of its own hold. A confirmed booking is the organiser's to cancel. A
   * booking of another exhibitor is not found, so ids reveal nothing.
   */
  async cancelOwnHold(
    access: OrgAccessContext,
    bookingId: string,
    exhibitorId: string,
    reason: string | null,
    actor: Actor,
  ): Promise<BookingView> {
    await this.change(access, bookingId, actor, async (booking, event, em) => {
      if (booking.exhibitorId !== exhibitorId) {
        throw new NotFoundException('There is no such booking.');
      }
      if (booking.status !== 'held') {
        throw new ConflictException(
          'Only a hold is let go here. Ask the organiser to cancel a confirmed booking.',
        );
      }
      EventsService.assertOpen(event);
      Object.assign(booking, {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledById: actor.id,
        cancelReason: reason ?? 'Let go by the exhibitor',
      });
      await expireOpenPayments(em, [booking.id]);
      return { action: 'booking.cancelled', metadata: { reason, by: 'exhibitor' } };
    });
    return this.get(access, bookingId);
  }

  /**
   * Moves an active booking to another bookable stall of the same event, in any of its halls.
   * The booking takes the new stall's published price: it is a booking of that stall now.
   */
  async move(
    access: OrgAccessContext,
    bookingId: string,
    dto: MoveBookingDto,
    actor: Actor,
  ): Promise<BookingView> {
    await this.change(access, bookingId, actor, async (booking, event, em) => {
      if (!isActive(booking.status)) {
        throw new ConflictException(`A booking that is ${booking.status} does not move.`);
      }
      const closed = eventClosedReason(event);
      if (closed) throw new ConflictException(closed);
      const row = await em
        .getRepository(EventHallEntity)
        .findOne({ where: { eventId: event.id, hallId: dto.hallId }, relations: { hall: true } });
      if (!row) throw new NotFoundException('This hall is not in the event.');
      if (row.id === booking.eventHallId && dto.stallId === booking.stallId) {
        throw new ConflictException('The booking is already on this stall.');
      }
      const to = await this.lockFreeStall(em, row, dto.stallId);
      const from = { stall: booking.stallLabel, amountPaise: booking.amountPaise };
      Object.assign(booking, {
        eventHallId: row.id,
        stallId: to.stallId,
        stallLabel: stallLabel(to),
        amountPaise: to.pricePaise!,
        currency: to.currency!,
        priceReckoning: to.priceReckoning!,
      });
      // The open order is for the old stall and price (ruling 5).
      await expireOpenPayments(em, [booking.id]);
      return {
        action: 'booking.moved',
        metadata: {
          from: from.stall,
          to: booking.stallLabel,
          amountPaise: { from: from.amountPaise, to: booking.amountPaise },
        },
      };
    });
    return this.get(access, bookingId);
  }

  /**
   * Marks held bookings whose time ran out as expired, and audits each (no actor: the platform
   * did it). One UPDATE whose WHERE names the state it leaves, so it is safe on several API
   * instances at once without a lock of our own: when two run together, Postgres makes the second
   * wait on the rows the first changed, then re-checks them, finds them no longer `held` and
   * skips them; each hold expires once and is audited once. A staff confirm racing it takes the
   * same row lock; whichever commits first wins, and the other sees the result.
   */
  async expireHolds(): Promise<number> {
    return this.dataSource.transaction(async (em) => {
      const { raw } = await em
        .createQueryBuilder()
        .update(BookingEntity)
        .set({ status: 'expired' })
        .where(`status = 'held' AND hold_expires_at < now()`)
        .returning('id, organisation_id, stall_label, hold_expires_at')
        .execute();
      const rows = raw as Array<{
        id: string;
        organisation_id: string;
        stall_label: string;
        hold_expires_at: Date;
      }>;
      await expireOpenPayments(
        em,
        rows.map((b) => b.id),
      );
      for (const b of rows) {
        await this.audit.record(
          {
            action: 'booking.expired',
            actor: null,
            organisationId: b.organisation_id,
            targetType: 'booking',
            targetId: b.id,
            metadata: {
              stall: b.stall_label,
              from: 'held',
              to: 'expired',
              holdExpiredAt: b.hold_expires_at,
            },
          },
          em,
        );
      }
      return rows.length;
    });
  }
  static stallView(s: PublishedStallEntity): PublishedStallView {
    return {
      id: s.stallId,
      label: stallLabel(s),
      islandNumber: s.islandNumber,
      stallNumber: s.stallNumber,
      x: s.x,
      y: s.y,
      width: s.width,
      depth: s.depth,
      openSides: s.openSides,
      scheme: s.scheme,
      isPremium: s.isPremium,
      isBlocked: s.isBlocked,
      isActive: s.isActive,
      price:
        s.pricePaise !== null && s.currency && s.priceReckoning
          ? { amountPaise: s.pricePaise, currency: s.currency, reckoning: s.priceReckoning }
          : null,
    };
  }

  // ---- helpers ------------------------------------------------------------------------------

  /** The event row, share-locked: see the class comment. */
  private lockEvent(em: EntityManager, eventId: string): Promise<EventEntity> {
    return em
      .getRepository(EventEntity)
      .findOneOrFail({ where: { id: eventId }, lock: { mode: 'pessimistic_read' } });
  }

  /**
   * The published stall, row-locked, when it can be booked. The plan row is share-locked first,
   * so a re-publish waits for this booking and then sees it.
   */
  async lockFreeStall(
    em: EntityManager,
    row: EventHallEntity,
    stallId: string,
  ): Promise<PublishedStallEntity> {
    await em
      .getRepository(StallPlanEntity)
      .findOne({ where: { eventHallId: row.id }, lock: { mode: 'pessimistic_read' } });
    const stall = await em.getRepository(PublishedStallEntity).findOne({
      where: { eventHallId: row.id, stallId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!stall) {
      throw new NotFoundException(
        `This stall is not on the published plan of ${row.hall?.name ?? 'the hall'}.`,
      );
    }
    const active = await em.getRepository(BookingEntity).findOneBy({
      eventHallId: row.id,
      stallId,
      status: In([...ACTIVE_BOOKING_STATUSES]),
    });
    const reason = stallClosedReason(stall, stallLabel(stall), active?.status ?? null);
    if (reason) throw new ConflictException(reason);
    return stall;
  }

  /** One change to a booking the member may see, under the locks, recorded in the audit log. */
  private async change(
    access: OrgAccessContext,
    bookingId: string,
    actor: Actor,
    apply: (
      booking: BookingEntity,
      event: EventEntity,
      em: EntityManager,
    ) => Change | Promise<Change>,
  ): Promise<void> {
    const visible = EventsService.visibleIds(access);
    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(BookingEntity);
      const found = await repo.findOneBy({ id: bookingId, organisationId: access.organisation.id });
      if (!found || (visible && !visible.includes(found.eventId))) {
        throw new NotFoundException('There is no such booking.');
      }
      const event = await this.lockEvent(em, found.eventId);
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
          metadata: {
            event: event.name,
            stall: booking.stallLabel,
            from,
            to: booking.status,
            ...metadata,
          },
        },
        em,
      );
    });
  }

  /** Bookings the member may see, newest first: organisers only at their events. */
  private async find(access: OrgAccessContext, filter: BookingFilter): Promise<BookingView[]> {
    const params: unknown[] = [access.organisation.id];
    const where = ['b.organisation_id = $1'];
    // Fixed fragments only; every value is a parameter.
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    const visible = EventsService.visibleIds(access);
    if (visible) add('b.event_id = ANY(?::uuid[])', visible);
    if (filter.bookingId) add('b.id = ?', filter.bookingId);
    if (filter.eventId) add('b.event_id = ?', filter.eventId);
    if (filter.exhibitorId) add('b.exhibitor_id = ?', filter.exhibitorId);
    if (filter.status) add('b.status = ?', filter.status);
    const rows: BookingRow[] = await this.dataSource.query(
      `SELECT b.id, b.event_id, e.name AS event_name, e.status AS event_status,
              h.id AS hall_id, h.name AS hall_name, b.stall_id, b.stall_label,
              b.exhibitor_id, x.name AS exhibitor_name, b.channel, b.status, b.hold_expires_at,
              b.amount_paise, b.currency, b.price_reckoning, b.note, b.cancel_reason,
              b.created_at, b.confirmed_at, b.cancelled_at, b.updated_at,
              pay.status AS pay_status, pay.provider AS pay_provider,
              pay.provider_order_id AS pay_order_id, pay.provider_payment_id AS pay_payment_id,
              pay.method AS pay_method, pay.amount_paise AS pay_amount_paise,
              pay.paid_at AS pay_paid_at, pay.refunded_paise AS pay_refunded_paise,
              pay.refund_pending_paise AS pay_refund_pending_paise
         FROM bookings b
         JOIN events e ON e.id = b.event_id
         JOIN event_halls eh ON eh.id = b.event_hall_id
         JOIN halls h ON h.id = eh.hall_id
         JOIN exhibitors x ON x.id = b.exhibitor_id
         LEFT JOIN LATERAL (
           SELECT p.status, p.provider, p.provider_order_id, p.provider_payment_id, p.method,
                  p.amount_paise, p.paid_at,
                  COALESCE((SELECT sum(r.amount_paise) FROM refunds r
                             WHERE r.payment_id = p.id AND r.status = 'processed'), 0) AS refunded_paise,
                  COALESCE((SELECT sum(r.amount_paise) FROM refunds r
                             WHERE r.payment_id = p.id AND r.status IN ('requested', 'sending')), 0) AS refund_pending_paise
             FROM payments p
            WHERE p.booking_id = b.id
            ORDER BY (p.paid_at IS NULL), p.created_at DESC
            LIMIT 1) pay ON true
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
      stall: { id: r.stall_id, label: r.stall_label },
      exhibitor: { id: r.exhibitor_id, name: r.exhibitor_name },
      channel: r.channel,
      status: r.status,
      holdExpiresAt: r.hold_expires_at?.toISOString() ?? null,
      amountPaise: Number(r.amount_paise),
      currency: r.currency,
      priceReckoning: r.price_reckoning,
      note: r.note,
      cancelReason: r.cancel_reason,
      payment:
        r.pay_status && r.pay_provider && r.pay_order_id
          ? {
              status: r.pay_status,
              provider: r.pay_provider,
              orderId: r.pay_order_id,
              paymentId: r.pay_payment_id,
              method: r.pay_method,
              amountPaise: Number(r.pay_amount_paise),
              paidAt: r.pay_paid_at?.toISOString() ?? null,
              refundedPaise: Number(r.pay_refunded_paise),
              refundPendingPaise: Number(r.pay_refund_pending_paise),
            }
          : null,
      createdAt: r.created_at.toISOString(),
      confirmedAt: r.confirmed_at?.toISOString() ?? null,
      cancelledAt: r.cancelled_at?.toISOString() ?? null,
      updatedAt: r.updated_at.toISOString(),
    };
  }
}
