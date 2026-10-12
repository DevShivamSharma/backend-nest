import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { portalClosedReason } from '../bookings/booking-rules';
import type { BookingView, StallMapView } from '../bookings/booking.views';
import { BookingsService } from '../bookings/bookings.service';
import type { Actor, OrgAccessContext } from '../common/http/authenticated-request';
import { EventEntity } from '../events/event.entity';
import { EventsService } from '../events/events.service';
import { EventExhibitorEntity } from '../exhibitors/exhibitor.entity';
import { ExhibitorsService } from '../exhibitors/exhibitors.service';
import { PortalCancelDto, PortalHoldDto } from './dto/portal.dto';
import type { PortalEventView, PortalHoldView, PortalView } from './portal.views';

/** A registered event hall with what the portal shows of it. */
interface HallRow {
  event_id: string;
  hall_id: string;
  name: string;
  published: boolean;
  free_stalls: number;
}

/**
 * The exhibitor portal (docs/15 §5.3, external channel; ported from `@feature/rules` and
 * retargeted at the published plan). Everything is for the exhibitor the membership is linked to;
 * the request never names one. Holding is the same booking as staff make, on the same locks, with
 * the portal's own rule (`portalClosedReason`) in front.
 */
@Injectable()
export class PortalService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly exhibitors: ExhibitorsService,
    private readonly bookingsService: BookingsService,
  ) {}

  /** The exhibitor this member acts for. */
  static exhibitorOf(access: OrgAccessContext): string {
    const exhibitorId = access.membership.scope.exhibitorId;
    if (!exhibitorId) throw new ForbiddenException('Your access is not linked to an exhibitor.');
    return exhibitorId;
  }

  /** The member's company and the events it is registered for, with free stalls per hall. */
  async portal(access: OrgAccessContext): Promise<PortalView> {
    const exhibitorId = PortalService.exhibitorOf(access);
    const em = this.dataSource.manager;
    const exhibitor = await this.exhibitors.getOwn(em, access.organisation.id, exhibitorId);
    const visible = EventsService.visibleIds(access);
    const query = em
      .getRepository(EventEntity)
      .createQueryBuilder('e')
      .innerJoin(
        EventExhibitorEntity,
        'ee',
        'ee.eventId = e.id AND ee.exhibitorId = :exhibitorId',
        {
          exhibitorId,
        },
      )
      .where('e.organisationId = :organisationId', { organisationId: access.organisation.id });
    if (visible) {
      // An empty list would make `IN ()` invalid SQL; it also means nothing is visible.
      if (visible.length === 0) query.andWhere('1 = 0');
      else query.andWhere('e.id IN (:...visible)', { visible });
    }
    const events = await query.orderBy('e.startsOn', 'ASC').addOrderBy('e.id').getMany();

    const halls: HallRow[] = events.length
      ? await em.query(
          `SELECT eh.event_id, eh.hall_id, h.name,
                  (sp.published_revision IS NOT NULL) AS published,
                  (SELECT count(*)::int FROM published_stalls ps
                    WHERE ps.event_hall_id = eh.id AND ps.is_active AND NOT ps.is_blocked
                      AND ps.price_paise IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM bookings b
                                       WHERE b.event_hall_id = ps.event_hall_id AND b.stall_id = ps.stall_id
                                         AND b.status IN ('held', 'confirmed'))) AS free_stalls
             FROM event_halls eh
             JOIN halls h ON h.id = eh.hall_id
             LEFT JOIN stall_plans sp ON sp.event_hall_id = eh.id
            WHERE eh.event_id = ANY($1::uuid[])
            ORDER BY h.name`,
          [events.map((e) => e.id)],
        )
      : [];

    const eventViews: PortalEventView[] = events.map((e) => ({
      id: e.id,
      name: e.name,
      status: e.status,
      startsOn: e.startsOn,
      endsOn: e.endsOn,
      organiserName: e.organiserName,
      closedReason: portalClosedReason(access.organisation, e),
      halls: halls
        .filter((h) => h.event_id === e.id)
        .map((h) => ({
          hallId: h.hall_id,
          name: h.name,
          published: h.published,
          freeStalls: h.free_stalls,
        })),
    }));
    return {
      exhibitor: { id: exhibitor.id, name: exhibitor.name },
      closedReason: access.organisation.features.exhibitorPortal
        ? null
        : `${access.organisation.name} does not take stall bookings online yet.`,
      events: eventViews,
    };
  }

  /**
   * The hall's published stalls for an event the exhibitor is registered for. Other exhibitors'
   * stalls stay held or booked on the map but lose the name of who holds them.
   */
  async stallMap(access: OrgAccessContext, eventId: string, hallId: string): Promise<StallMapView> {
    const exhibitorId = PortalService.exhibitorOf(access);
    const em = this.dataSource.manager;
    if (!(await this.exhibitors.isRegistered(em, eventId, exhibitorId))) {
      throw new NotFoundException('There is no such event.');
    }
    const event = await this.events.eventFor(em, access, eventId);
    const map = await this.bookingsService.stallMap(access, eventId, hallId);
    const closed = portalClosedReason(access.organisation, event) ?? map.closedReason;
    return {
      ...map,
      bookable: !closed,
      closedReason: closed,
      stalls: map.stalls.map((s) => ({
        ...s,
        booking: s.booking?.exhibitorId === exhibitorId ? s.booking : null,
      })),
    };
  }

  /** The exhibitor's own bookings, newest first. */
  bookings(access: OrgAccessContext): Promise<BookingView[]> {
    return this.bookingsService.list(access, { exhibitorId: PortalService.exhibitorOf(access) });
  }

  /** Holds a free stall for the exhibitor; paying for it comes with M6. */
  async hold(access: OrgAccessContext, dto: PortalHoldDto, actor: Actor): Promise<PortalHoldView> {
    const exhibitorId = PortalService.exhibitorOf(access);
    const booking = await this.bookingsService.create(
      access,
      { ...dto, exhibitorId, confirm: false },
      actor,
      'external',
    );
    return { booking, checkout: null, paymentError: null };
  }

  /** The exhibitor lets go of its own hold. */
  cancel(
    access: OrgAccessContext,
    bookingId: string,
    dto: PortalCancelDto,
    actor: Actor,
  ): Promise<BookingView> {
    return this.bookingsService.cancelOwnHold(
      access,
      bookingId,
      PortalService.exhibitorOf(access),
      dto.reason ?? null,
      actor,
    );
  }
}
