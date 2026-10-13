import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';

import { portalClosedReason } from '../bookings/booking-rules';
import type { MapStallView } from '../bookings/booking.views';
import { BookingsService } from '../bookings/bookings.service';
import { EventEntity, EventHallEntity } from '../events/event.entity';
import type { OrganisationEntity } from '../organisations/organisation.entity';
import { OrganisationsService } from '../organisations/organisations.service';
import { HallFloorVersionEntity } from '../venues/hall.entity';
import type {
  PublicEventView,
  PublicStallMapView,
  PublicStallState,
  PublicStallView,
} from './public-events.views';

/** The one message for everything that is not there, so ids and slugs reveal nothing. */
const NOT_FOUND = 'There is no such event.';

/** A published hall of the event with its stalls for sale. */
interface HallRow {
  hall_id: string;
  name: string;
  width: number;
  depth: number;
  floor_area: number;
  total_stalls: number;
  free_stalls: number;
}

/**
 * The public view of an event (for the demo and for sharing a link with exhibitors). It reads the
 * published snapshot only, and reaches the stall map through the same `BookingsService` the staff
 * and the portal use, then drops everything personal from it.
 */
@Injectable()
export class PublicEventsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly organisations: OrganisationsService,
    private readonly bookings: BookingsService,
  ) {}

  async event(slug: string, eventId: string): Promise<PublicEventView> {
    const { organisation, event } = await this.find(slug, eventId);
    const halls: HallRow[] = await this.dataSource.query(
      `SELECT h.id AS hall_id, h.name, h.width, h.depth, h.floor_area,
              (SELECT count(*)::int FROM published_stalls ps
                WHERE ps.event_hall_id = eh.id AND ps.is_active AND NOT ps.is_blocked
                  AND ps.price_paise IS NOT NULL) AS total_stalls,
              (SELECT count(*)::int FROM published_stalls ps
                WHERE ps.event_hall_id = eh.id AND ps.is_active AND NOT ps.is_blocked
                  AND ps.price_paise IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM bookings b
                                   WHERE b.event_hall_id = ps.event_hall_id AND b.stall_id = ps.stall_id
                                     AND b.status IN ('held', 'confirmed'))) AS free_stalls
         FROM event_halls eh
         JOIN halls h ON h.id = eh.hall_id
         JOIN stall_plans sp ON sp.event_hall_id = eh.id AND sp.published_revision IS NOT NULL
        WHERE eh.event_id = $1
        ORDER BY h.name`,
      [event.id],
    );
    const closedReason = portalClosedReason(organisation, event);
    return {
      organisation: {
        slug: organisation.slug,
        name: organisation.name,
        branding: organisation.config.branding,
      },
      event: {
        id: event.id,
        name: event.name,
        status: event.status,
        startsOn: event.startsOn,
        endsOn: event.endsOn,
        organiserName: event.organiserName,
      },
      halls: halls.map((h) => ({
        hallId: h.hall_id,
        name: h.name,
        width: h.width,
        depth: h.depth,
        floorArea: h.floor_area,
        totalStalls: h.total_stalls,
        freeStalls: h.free_stalls,
      })),
      bookingOpen: !closedReason,
      closedReason,
      contactEmail: organisation.config.legal.supportEmail,
    };
  }

  async stallMap(slug: string, eventId: string, hallId: string): Promise<PublicStallMapView> {
    const { organisation, event } = await this.find(slug, eventId);
    if (!isUUID(hallId)) throw new NotFoundException(NOT_FOUND);
    const em = this.dataSource.manager;
    const row = await em
      .getRepository(EventHallEntity)
      .findOne({ where: { eventId: event.id, hallId }, relations: { hall: true } });
    if (!row) throw new NotFoundException(NOT_FOUND);
    const floor = await em
      .getRepository(HallFloorVersionEntity)
      .findOneByOrFail({ hallId, version: row.floorVersion });
    const map = await this.bookings.stallMapOf(
      event,
      row,
      { hallId, name: row.hall!.name, floorVersion: row.floorVersion },
      floor.floor,
    );
    // A hall without a published plan has nothing to show; to the public it is not there.
    if (!map.published) throw new NotFoundException(NOT_FOUND);
    const closedReason = portalClosedReason(organisation, event) ?? map.closedReason;
    return {
      event: map.event,
      hall: map.hall,
      bookingOpen: !closedReason,
      closedReason,
      floor: map.floor,
      stalls: map.stalls.map(PublicEventsService.stallView),
    };
  }

  /** Held and booked look alike here, and the booking and who holds it are left out. */
  private static stallView(s: MapStallView): PublicStallView {
    const state: PublicStallState =
      s.state === 'free' ? 'free' : s.state === 'not_for_sale' ? 'not_for_sale' : 'unavailable';
    // Built field by field, not spread, so a field added to the staff view is not public by accident.
    return {
      id: s.id,
      label: s.label,
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
      price: s.price,
      state,
    };
  }

  /** The organisation and its event; a draft or cancelled event is not found, like an unknown one. */
  private async find(
    slug: string,
    eventId: string,
  ): Promise<{ organisation: OrganisationEntity; event: EventEntity }> {
    const organisation = slug.length <= 40 ? await this.organisations.resolvePublic(slug) : null;
    if (!organisation || !isUUID(eventId)) throw new NotFoundException(NOT_FOUND);
    const event = await this.dataSource
      .getRepository(EventEntity)
      .findOneBy({ id: eventId, organisationId: organisation.id });
    if (!event || event.status === 'draft' || event.status === 'cancelled') {
      throw new NotFoundException(NOT_FOUND);
    }
    return { organisation, event };
  }
}
