import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import type { SessionUser } from '../../auth/domain/session-user';
import type {
  AddEventHallsDto,
  CreateInternalEventDto,
  UpdateEventHallDto,
  UpdateInternalEventDto,
} from '../dto/events.dto';

export interface InternalEvent {
  id: string;
  bookingId: string;
  name: string;
  startDate: string;
  endDate: string;
  visibilityStatus: boolean;
}

export interface EventHall {
  id: string;
  hallId: number;
  name: string;
  forStallFnb: boolean;
}

/** Held while a booking id is made, so two events at once cannot be given the same number. */
const BOOKING_ID_LOCK = 7_300_002;
/** ITPO's hall-booking prefix in a booking id: H-<year><month><5 digit serial>. */
const HALL_PREFIX = 'H';

/**
 * The user's fields of an event, and the `T_HALL_BOOKING` column each one is saved in. A fixed
 * list: only these are ever written, whatever else arrives.
 */
const EVENT_COLUMNS: Record<string, string> = {
  name: 'event_name',
  startDate: 'tenancy_period_start_date',
  endDate: 'tenancy_period_end_date',
  eventType: 'event_type',
  eventFormat: 'event_format',
  coOrganizerName: 'co_organizer_name',
  description: 'event_desc',
  productProfile: 'product_profile',
  specificProductProfile: 'specific_product_profile',
  productCategory: 'product_category',
  exhibitionStartDate: 'exhibition_period_from_date',
  exhibitionEndDate: 'exhibition_period_to_date',
  startTimeOfEvent: 'start_time_of_event',
  endTimeOfEvent: 'end_time_of_event',
  expectedNumberOfVisitor: 'expected_number_of_visitor',
  expectedNumberOfExhibitors: 'expected_number_of_exhibitors',
  noOfStalls: 'no_of_stalls',
  noOfFnbStalls: 'no_of_fnb_stalls',
  maxCategoriesForRegistration: 'max_categories_for_registration',
  specialRequest: 'special_request',
  fileNumber: 'file_number',
  remarks: 'remarks',
  bannerImageId: 'banner_image_id',
  allowOverseasUser: 'allow_overseas_user',
  isMarqueeEnabled: 'is_marquee_enabled',
  isSecondaryEnabled: 'is_secondary_enabled',
  visibilityStatus: 'visibility_status',
};

/** The user's fields of an event hall, and the `T_EVENT_HALL` column each one is saved in. */
const HALL_COLUMNS: Record<string, string> = {
  hallCode: 'hall_code',
  hallArea: 'hall_area',
  mountingPeriodFromDate: 'mounting_period_from_date',
  mountingPeriodToDate: 'mounting_period_to_date',
  exhibitionPeriodFromDate: 'exhibition_period_from_date',
  exhibitionPeriodToDate: 'exhibition_period_to_date',
  dismantlingPeriodFromDate: 'dismantling_period_from_date',
  dismantlingPeriodToDate: 'dismantling_period_to_date',
  numberOfComplimentaryDay: 'number_of_complimentary_day',
  isBookedForFnb: 'is_booked_for_fnb',
  fnbRemark: 'fnb_remark',
  isPartialBooked: 'is_partial_booked',
  stallBookingStartDate: 'stall_booking_start_date',
  stallBookingEndDate: 'stall_booking_end_date',
  noOfStalls: 'no_of_stalls',
  noOfFnbStalls: 'no_of_fnb_stalls',
  remark: 'remark',
  bookedArea: 'booked_area',
  requestedArea: 'requested_area',
  isNtaAreaRequest: 'is_nta_area_request',
  ntaPricingType: 'nta_pricing_type',
};

/** The date pairs of a hall (from, to), each checked to run forwards. */
const HALL_PERIODS = [
  ['mountingPeriodFromDate', 'mountingPeriodToDate', 'mounting'],
  ['exhibitionPeriodFromDate', 'exhibitionPeriodToDate', 'exhibition'],
  ['dismantlingPeriodFromDate', 'dismantlingPeriodToDate', 'dismantling'],
  ['stallBookingStartDate', 'stallBookingEndDate', 'stall booking'],
] as const;

/** Fields that exist on every event and hall: editing may change them, never clear them. */
const EVENT_NOT_CLEARABLE = new Set([
  'name',
  'startDate',
  'endDate',
  'fileNumber',
  'allowOverseasUser',
  'isMarqueeEnabled',
  'isSecondaryEnabled',
  'visibilityStatus',
]);
const HALL_NOT_CLEARABLE = new Set([
  'numberOfComplimentaryDay',
  'isPartialBooked',
  'isBookedForFnb',
  'isNtaAreaRequest',
  'forStallFnb',
]);

/**
 * Internal events (ITPO's own), written the way ITPO's hall-booking flow writes them: a row in
 * `T_HALL_BOOKING`, approved and completed from the start because no one has to approve ITPO's
 * own event, and halls in `T_EVENT_HALL`. Invoices, prices and charges are for when booking
 * starts, and are left empty here.
 */
@Injectable()
export class EventsService {
  constructor(private readonly db: DataSource) {}

  async createInternal(dto: CreateInternalEventDto, user: SessionUser): Promise<InternalEvent> {
    const orgId = dto.organisationId;
    for (const key of [
      'startDate',
      'endDate',
      'exhibitionStartDate',
      'exhibitionEndDate',
    ] as const) {
      if (dto[key] !== undefined && !isRealDate(dto[key])) {
        throw new BadRequestException(`${key} is not a real calendar date.`);
      }
    }
    if (dto.endDate < dto.startDate) {
      throw new BadRequestException('The event cannot end before it starts.');
    }
    if (
      dto.exhibitionStartDate &&
      dto.exhibitionEndDate &&
      dto.exhibitionEndDate < dto.exhibitionStartDate
    ) {
      throw new BadRequestException('The exhibition cannot end before it starts.');
    }

    return this.db.transaction(async (tx) => {
      // As in SelfCare, the organisation is the one the staff member chose; it must be a live one.
      const [org] = await tx.query<{ name: string }[]>(
        `SELECT name FROM idp."T_ORGANIZATION" WHERE id = $1 AND is_active = true`,
        [orgId],
      );
      if (!org) {
        throw new BadRequestException('Organisation not found.');
      }

      const bookingId = await nextBookingId(tx, dto.startDate);
      const given = pick(dto as unknown as Record<string, unknown>, EVENT_COLUMNS);
      const eventType = dto.eventType ?? 'B2B & B2C both';
      const columns: [string, unknown][] = [
        // Set by the system, as ITPO's flow does for an internal event.
        ['booking_id', bookingId],
        ['event_booking_type', 'internal'],
        ['booking_status', 'Completed'],
        ['approval_status', 'Approved'],
        ['organiser_name', org.name],
        ['org_id', orgId],
        ['created_by', user.id],
        ['event_type', eventType],
        // Given by the user.
        ...given.filter(([column]) => column !== 'event_type'),
      ];

      const [event] = await tx.query<{ id: string; visibility_status: boolean }[]>(
        `INSERT INTO idp."T_HALL_BOOKING" (${columns.map(([c]) => c).join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING id, visibility_status`,
        columns.map(([, v]) => v),
      );

      return {
        id: event.id,
        bookingId,
        name: dto.name,
        startDate: dto.startDate,
        endDate: dto.endDate,
        visibilityStatus: event.visibility_status === true,
      };
    });
  }

  /**
   * Edits an internal event: any of its fields, including the visibility toggle. An optional field
   * sent as null is cleared; the name, the dates and the flags cannot be.
   */
  async updateInternal(
    eventId: string,
    dto: UpdateInternalEventDto,
    user: SessionUser,
  ): Promise<InternalEvent> {
    const changes = changesOf(
      dto as unknown as Record<string, unknown>,
      EVENT_COLUMNS,
      EVENT_NOT_CLEARABLE,
    );
    if (changes.length === 0) {
      throw new BadRequestException('Nothing to change.');
    }
    for (const key of [
      'startDate',
      'endDate',
      'exhibitionStartDate',
      'exhibitionEndDate',
    ] as const) {
      const value = dto[key];
      if (typeof value === 'string' && !isRealDate(value)) {
        throw new BadRequestException(`${key} is not a real calendar date.`);
      }
    }

    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [eventId]);

      const [current] = await tx.query<EventRow[]>(
        `SELECT tenancy_period_start_date, tenancy_period_end_date,
                exhibition_period_from_date, exhibition_period_to_date
           FROM idp."T_HALL_BOOKING"
          WHERE id = $1 AND event_booking_type = 'internal' AND is_active = true`,
        [eventId],
      );
      if (!current) {
        throw new NotFoundException('Internal event not found.');
      }

      // The dates as they will stand: what is sent, over what is saved.
      const start = dto.startDate ?? day(current.tenancy_period_start_date)!;
      const end = dto.endDate ?? day(current.tenancy_period_end_date)!;
      if (end < start) {
        throw new BadRequestException('The event cannot end before it starts.');
      }
      const exhibitionStart =
        dto.exhibitionStartDate === undefined
          ? day(current.exhibition_period_from_date)
          : dto.exhibitionStartDate;
      const exhibitionEnd =
        dto.exhibitionEndDate === undefined
          ? day(current.exhibition_period_to_date)
          : dto.exhibitionEndDate;
      if (exhibitionStart && exhibitionEnd && exhibitionEnd < exhibitionStart) {
        throw new BadRequestException('The exhibition cannot end before it starts.');
      }

      const sets = changes.map(([column], i) => `${column} = $${i + 3}`);
      // TypeORM answers an UPDATE ... RETURNING as [rows, affected count].
      const [[event]] = await tx.query<[EventRow[], number]>(
        `UPDATE idp."T_HALL_BOOKING" SET ${sets.join(', ')}, updated_by = $2, updated_at = NOW()
          WHERE id = $1
        RETURNING booking_id, event_name, tenancy_period_start_date, tenancy_period_end_date, visibility_status`,
        [eventId, user.id, ...changes.map(([, value]) => value)],
      );

      return {
        id: eventId,
        bookingId: event.booking_id!,
        name: event.event_name!,
        startDate: day(event.tenancy_period_start_date)!,
        endDate: day(event.tenancy_period_end_date)!,
        visibilityStatus: event.visibility_status === true,
      };
    });
  }

  /**
   * Adds halls to an internal event, as ITPO's booking flow and SelfCare's "add halls" do: a row
   * in `T_EVENT_HALL` per hall, and for an F&B hall the F&B categories mapped to it. The hall's
   * name, code and area come from `T_HALLS` unless given. All or none.
   */
  async addHalls(
    eventId: string,
    dto: AddEventHallsDto,
  ): Promise<{ eventId: string; halls: EventHall[] }> {
    const ids = dto.halls.map((h) => h.hallId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('A hall appears more than once.');
    }
    dto.halls.forEach((h) =>
      checkHallDates(h as unknown as Record<string, unknown>, h.isNtaAreaRequest, h.ntaPricingType),
    );

    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [eventId]);

      const [event] = await tx.query<{ id: string }[]>(
        `SELECT id FROM idp."T_HALL_BOOKING"
          WHERE id = $1 AND event_booking_type = 'internal' AND is_active = true`,
        [eventId],
      );
      if (!event) {
        throw new NotFoundException('Internal event not found.');
      }

      const added: EventHall[] = [];
      for (const hallDto of dto.halls) {
        const { hallId } = hallDto;
        const forStallFnb = hallDto.forStallFnb ?? false;

        const [hall] = await tx.query<
          { name: string; hall_code: string | null; hall_area_capacity: string | null }[]
        >(`SELECT name, hall_code, hall_area_capacity FROM idp."T_HALLS" WHERE id = $1`, [hallId]);
        if (!hall) {
          throw new BadRequestException(`Hall ${hallId} does not exist.`);
        }

        const [already] = await tx.query<unknown[]>(
          `SELECT 1 FROM idp."T_EVENT_HALL" WHERE booking_id = $1 AND hall_id = $2`,
          [eventId, hallId],
        );
        if (already) {
          throw new ConflictException(`${hall.name} is already added to this event.`);
        }

        // As in the booking flow: a hall already held by another event on those days is refused.
        // An F&B hall is a shared space, and SelfCare adds it to events without this check.
        if (!forStallFnb) {
          await refuseIfBooked(
            tx,
            eventId,
            hallId,
            hall.name,
            hallDto as unknown as Record<string, unknown>,
          );
        }

        const given = pick(hallDto as unknown as Record<string, unknown>, HALL_COLUMNS);
        const givenColumns = new Set(given.map(([c]) => c));
        const columns: [string, unknown][] = [
          // Set by the system.
          ['booking_id', eventId],
          ['hall_id', hallId],
          ['hall_name', hall.name],
          ['is_stall_fnb', forStallFnb],
          ['is_default_hall', true],
          ['hall_addition_request_status', 'Approved'],
          ['created_at', new Date()],
          ['updated_at', new Date()],
          // From the hall itself, unless the user gave them.
          ...(givenColumns.has('hall_code')
            ? []
            : [['hall_code', hall.hall_code] as [string, unknown]]),
          ...(givenColumns.has('hall_area')
            ? []
            : [['hall_area', hall.hall_area_capacity] as [string, unknown]]),
          // Given by the user.
          ...given,
        ];

        const [row] = await tx.query<{ id: string }[]>(
          `INSERT INTO idp."T_EVENT_HALL" (${columns.map(([c]) => c).join(', ')})
           VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
           RETURNING id`,
          columns.map(([, v]) => v),
        );

        if (forStallFnb) {
          await mapFnbCategories(tx, row.id);
        }
        added.push({ id: row.id, hallId, name: hall.name, forStallFnb });
      }

      return { eventId, halls: added };
    });
  }

  /**
   * Edits a hall of an event (by its event-hall id): any of its fields. Dates are checked as they
   * will stand, and a hall other than an F&B one is refused if another event holds it on them.
   */
  async updateHall(
    eventId: string,
    eventHallId: string,
    dto: UpdateEventHallDto,
  ): Promise<EventHall> {
    const record = dto as unknown as Record<string, unknown>;
    const changes = changesOf(record, HALL_COLUMNS, HALL_NOT_CLEARABLE);
    if (dto.forStallFnb === null) {
      throw new BadRequestException('forStallFnb cannot be cleared.');
    }
    if (changes.length === 0 && dto.forStallFnb === undefined) {
      throw new BadRequestException('Nothing to change.');
    }

    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [eventId]);
      await requireInternalEvent(tx, eventId);

      const [current] = await tx.query<EventHallRow[]>(
        `SELECT id, hall_id, hall_name, is_stall_fnb, is_nta_area_request, nta_pricing_type,
                mounting_period_from_date, mounting_period_to_date,
                exhibition_period_from_date, exhibition_period_to_date,
                dismantling_period_from_date, dismantling_period_to_date,
                stall_booking_start_date, stall_booking_end_date
           FROM idp."T_EVENT_HALL" WHERE id = $1 AND booking_id = $2`,
        [eventHallId, eventId],
      );
      if (!current) {
        throw new NotFoundException('Hall not found in this event.');
      }

      // The periods as they will stand: what is sent, over what is saved.
      const standing: Record<string, unknown> = {};
      for (const [from, to] of HALL_PERIODS) {
        for (const [key, column] of [
          [from, HALL_COLUMNS[from]],
          [to, HALL_COLUMNS[to]],
        ] as const) {
          standing[key] =
            record[key] === undefined
              ? day(current[column as keyof EventHallRow] as string | Date | null)
              : record[key];
        }
      }
      const isNta = dto.isNtaAreaRequest ?? current.is_nta_area_request;
      let pricing =
        dto.ntaPricingType === undefined ? current.nta_pricing_type : dto.ntaPricingType;
      if (!isNta && dto.ntaPricingType === undefined && pricing !== null) {
        // No longer an NTA request: its pricing type goes with it.
        changes.push(['nta_pricing_type', null]);
        pricing = null;
      }
      checkHallDates(standing, isNta, pricing);

      const forStallFnb = dto.forStallFnb ?? current.is_stall_fnb;
      const datesChanged = HALL_PERIODS.some(
        ([from, to]) => record[from] !== undefined || record[to] !== undefined,
      );
      if (datesChanged && !forStallFnb) {
        await refuseIfBooked(tx, eventId, Number(current.hall_id), current.hall_name, standing);
      }

      const all: [string, unknown][] = [...changes];
      if (dto.forStallFnb !== undefined) {
        all.push(['is_stall_fnb', dto.forStallFnb]);
      }
      const sets = all.map(([column], i) => `${column} = $${i + 3}`);
      await tx.query(
        `UPDATE idp."T_EVENT_HALL" SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND booking_id = $2`,
        [eventHallId, eventId, ...all.map(([, value]) => value)],
      );

      // An F&B hall has the F&B categories mapped to it; turning that on or off follows it.
      if (dto.forStallFnb === true && !current.is_stall_fnb) {
        await mapFnbCategories(tx, eventHallId);
      } else if (dto.forStallFnb === false && current.is_stall_fnb) {
        await unmapFnbCategories(tx, eventHallId);
      }

      return {
        id: eventHallId,
        hallId: Number(current.hall_id),
        name: current.hall_name,
        forStallFnb,
      };
    });
  }

  /**
   * Takes a hall out of an event (by its event-hall id), as ITPO does, by deleting its row; its
   * category mappings and booked services go with it. A hall that already has a plan in the event
   * (a layout, stalls or prices) is refused, so a plan is never left without its hall.
   */
  async removeHall(eventId: string, eventHallId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [eventId]);
      await requireInternalEvent(tx, eventId);

      const [hall] = await tx.query<{ hall_name: string }[]>(
        `SELECT hall_name FROM idp."T_EVENT_HALL" WHERE id = $1 AND booking_id = $2`,
        [eventHallId, eventId],
      );
      if (!hall) {
        throw new NotFoundException('Hall not found in this event.');
      }

      const planned = await tx.query<unknown[]>(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM idp."T_STALLS" WHERE event_hall_id = $1)
                     OR EXISTS (SELECT 1 FROM idp."T_EVENT_HALL_LAYOUT_DATA" WHERE event_hall_id = $1)
                     OR EXISTS (SELECT 1 FROM idp."T_STALL_PRICE_MASTER" WHERE hall_id = $1)`,
        [eventHallId],
      );
      if (planned.length > 0) {
        throw new ConflictException(
          `${hall.hall_name} already has a plan in this event, so it cannot be removed.`,
        );
      }
      const serviced = await tx.query<unknown[]>(
        `SELECT 1 FROM idp."T_HALL_SERVICES_DETAIL" WHERE booked_hall_id = $1 LIMIT 1`,
        [eventHallId],
      );
      if (serviced.length > 0) {
        throw new ConflictException(
          `${hall.hall_name} has services booked in this event, so it cannot be removed.`,
        );
      }

      await tx.query(`DELETE FROM idp."T_EVENT_HALL" WHERE id = $1 AND booking_id = $2`, [
        eventHallId,
        eventId,
      ]);
    });
  }
}

/** The given fields (not undefined, not null), as [column, value] pairs, only from the fixed map. */
function pick(
  source: Record<string, unknown>,
  columns: Record<string, string>,
): [string, unknown][] {
  return Object.entries(columns)
    .filter(([key]) => source[key] !== undefined && source[key] !== null)
    .map(([key, column]) => [column, source[key]]);
}

/**
 * The fields an edit changes, as [column, value] pairs: whatever is sent, null included (it
 * clears the field), except for fields that cannot be cleared.
 */
function changesOf(
  source: Record<string, unknown>,
  columns: Record<string, string>,
  notClearable: Set<string>,
): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [key, column] of Object.entries(columns)) {
    const value = source[key];
    if (value === undefined) continue;
    if (value === null && notClearable.has(key)) {
      throw new BadRequestException(`${key} cannot be cleared.`);
    }
    out.push([column, value]);
  }
  return out;
}

/** A date or timestamp from the database as YYYY-MM-DD (a timestamp in the server's own day). */
function day(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

interface EventRow {
  booking_id?: string;
  event_name?: string;
  tenancy_period_start_date: string | Date | null;
  tenancy_period_end_date: string | Date | null;
  exhibition_period_from_date?: string | Date | null;
  exhibition_period_to_date?: string | Date | null;
  visibility_status?: boolean | null;
}

interface EventHallRow {
  id: string;
  hall_id: string | number;
  hall_name: string;
  is_stall_fnb: boolean;
  is_nta_area_request: boolean;
  nta_pricing_type: string | null;
  mounting_period_from_date: string | null;
  mounting_period_to_date: string | null;
  exhibition_period_from_date: string | null;
  exhibition_period_to_date: string | null;
  dismantling_period_from_date: string | null;
  dismantling_period_to_date: string | null;
  stall_booking_start_date: string | Date | null;
  stall_booking_end_date: string | Date | null;
}

async function requireInternalEvent(tx: EntityManager, eventId: string): Promise<void> {
  const [event] = await tx.query<{ id: string }[]>(
    `SELECT id FROM idp."T_HALL_BOOKING"
      WHERE id = $1 AND event_booking_type = 'internal' AND is_active = true`,
    [eventId],
  );
  if (!event) {
    throw new NotFoundException('Internal event not found.');
  }
}

/** Each date pair must be real and run forwards; one end alone is not a period. */
function checkHallDates(
  hall: Record<string, unknown>,
  isNta: boolean | undefined,
  pricing: string | null | undefined,
): void {
  for (const [from, to, label] of HALL_PERIODS) {
    const start = hall[from] as string | null | undefined;
    const end = hall[to] as string | null | undefined;
    const hasStart = start !== undefined && start !== null;
    const hasEnd = end !== undefined && end !== null;
    if (hasStart !== hasEnd) {
      throw new BadRequestException(`The ${label} period needs both a start and an end.`);
    }
    if (hasStart && hasEnd) {
      if (!isRealDate(start) || !isRealDate(end)) {
        throw new BadRequestException(`The ${label} dates must be real calendar dates.`);
      }
      if (end < start) {
        throw new BadRequestException(`The ${label} period cannot end before it starts.`);
      }
    }
  }
  if (pricing !== undefined && pricing !== null && isNta !== true) {
    throw new BadRequestException('ntaPricingType is only for an NTA area request.');
  }
}

/**
 * ITPO's overlap rule for a hall: another active event (not cancelled or rejected) holding the
 * hall in the same mounting, exhibition or dismantling days refuses it. Only when the hall has
 * dates to compare.
 */
async function refuseIfBooked(
  tx: EntityManager,
  eventId: string,
  hallId: number,
  hallName: string,
  dates: Record<string, unknown>,
): Promise<void> {
  const get = (key: string) => (typeof dates[key] === 'string' ? (dates[key] as string) : null);
  const exFrom = get('exhibitionPeriodFromDate');
  const exTo = get('exhibitionPeriodToDate');
  const moFrom = get('mountingPeriodFromDate');
  const moTo = get('mountingPeriodToDate');
  const diFrom = get('dismantlingPeriodFromDate');
  const diTo = get('dismantlingPeriodToDate');
  if (!exFrom && !moFrom && !diFrom) {
    return;
  }

  const [clash] = await tx.query<{ event_name: string | null }[]>(
    `SELECT hb.event_name
       FROM idp."T_EVENT_HALL" eh
       JOIN idp."T_HALL_BOOKING" hb ON hb.id = eh.booking_id
      WHERE eh.hall_id = $1
        AND eh.booking_id <> $2
        AND hb.approval_status NOT IN ('Cancelled', 'Rejected')
        AND hb.is_active = true
        AND eh.cancellation_status IS DISTINCT FROM 'Approved'
        AND hb.rescheduled_status IS DISTINCT FROM 'Rejected'
        AND (
          ($3::date IS NOT NULL AND eh.exhibition_period_from_date IS NOT NULL
             AND eh.exhibition_period_from_date <= $4::date AND eh.exhibition_period_to_date >= $3::date)
          OR ($5::date IS NOT NULL AND eh.mounting_period_from_date IS NOT NULL
             AND eh.mounting_period_from_date <= $6::date AND eh.mounting_period_to_date >= $5::date)
          OR ($7::date IS NOT NULL AND eh.dismantling_period_from_date IS NOT NULL
             AND eh.dismantling_period_from_date <= $8::date AND eh.dismantling_period_to_date >= $7::date)
        )
      LIMIT 1`,
    [hallId, eventId, exFrom, exTo, moFrom, moTo, diFrom, diTo],
  );
  if (clash) {
    throw new ConflictException(
      `${hallName} is already booked for those dates${clash.event_name ? ` by ${clash.event_name}` : ''}.`,
    );
  }
}

/** The F&B categories mapped to an event hall are taken off it again. */
async function unmapFnbCategories(tx: EntityManager, eventHallId: string): Promise<void> {
  await tx.query(
    `DELETE FROM idp."T_HALL_CATEGORY_MAPPING"
      WHERE hall_id = $1
        AND product_category_id IN (
          SELECT cm.id FROM idp."T_CODE_TYPE" ct
            JOIN idp."T_CODE_MASTER" cm ON ct.id = cm."typeId"
           WHERE ct.slug = 'f&b')`,
    [eventHallId],
  );
}

/** SelfCare's rule for an F&B hall: every category of the "f&b" code type is mapped to it. */
async function mapFnbCategories(tx: EntityManager, eventHallId: string): Promise<void> {
  const categories = await tx.query<{ id: number }[]>(
    `SELECT cm.id
       FROM idp."T_CODE_TYPE" ct
       JOIN idp."T_CODE_MASTER" cm ON ct.id = cm."typeId"
      WHERE ct.slug = 'f&b'`,
  );
  for (const { id } of categories) {
    await tx.query(
      `INSERT INTO idp."T_HALL_CATEGORY_MAPPING" (hall_id, product_category_id) VALUES ($1, $2)`,
      [eventHallId, id],
    );
  }
}

/**
 * ITPO's booking id: `H-` + year and month of the event's start + a 5 digit serial that carries
 * on from the last one of that month, kept in `T_EVENT_BOOKING_ID_TRACKER`.
 */
async function nextBookingId(tx: EntityManager, startDate: string): Promise<string> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [BOOKING_ID_LOCK]);

  const dateCode = startDate.slice(0, 4) + startDate.slice(5, 7);
  const [latest] = await tx.query<{ booking_id: string }[]>(
    `SELECT booking_id FROM idp."T_EVENT_BOOKING_ID_TRACKER"
      WHERE prefix = $1 AND date_code = $2
      ORDER BY booking_id DESC LIMIT 1`,
    [HALL_PREFIX, dateCode],
  );
  const serial = latest ? parseInt(latest.booking_id.slice(-5), 10) + 1 : 1;
  const bookingId = `${HALL_PREFIX}-${dateCode}${String(serial).padStart(5, '0')}`;

  await tx.query(
    `INSERT INTO idp."T_EVENT_BOOKING_ID_TRACKER" (booking_id, prefix, date_code, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (booking_id) DO NOTHING`,
    [bookingId, HALL_PREFIX, dateCode],
  );
  return bookingId;
}

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
