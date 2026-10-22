import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';

import { AuditService } from '../../audit/audit.service';
import { EventHallCategoryEntity, StallCategoryEntity } from '../../categories/category.entity';
import type { Actor, OrgAccessContext } from '../../common/http/authenticated-request';
import { EventEntity, EventHallEntity, EventKind } from '../../events/event.entity';
import { EventsService } from '../../events/events.service';
import type { EventType } from '../../rules/rule-catalogue';
import { RulesService } from '../../rules/rules.service';
import { UserEntity } from '../../users/user.entity';
import { HallEntity } from '../../venues/hall.entity';
import { ItpoHallImportService } from '../../venues/itpo-hall-import.service';
import { VenueEntity } from '../../venues/venue.entity';
import { ExternalRefEntity } from '../external-ref.entity';
import { setExternalId } from '../external-refs';

/** The venue ITPO's halls are mirrored into. */
const VENUE_NAME = 'Bharat Mandapam';
/** ITPO's events that are not shown: refused, cancelled or never sent. */
const HIDDEN_APPROVAL = ['Cancelled', 'Rejected'];
const LIST_LIMIT = 200;

/** An event of ITPO's (T_HALL_BOOKING), as the event lists show it. */
export interface ItpoEventView {
  /** T_HALL_BOOKING.id */
  id: string;
  /** ITPO's booking number, e.g. H-20260811116. */
  code: string | null;
  name: string;
  kind: EventKind;
  organiserName: string | null;
  startsOn: string | null;
  endsOn: string | null;
  approvalStatus: string | null;
  bookingStatus: string | null;
  halls: number;
  /** Our event standing for it, once it was opened here. */
  eventId: string | null;
}

/** One hall of an ITPO event (T_EVENT_HALL). */
export interface ItpoEventHallView {
  /** T_EVENT_HALL.id */
  id: string;
  /** T_HALLS.id */
  hallId: string;
  name: string;
  /** Whether ITPO has the hall's floor (T_HALL_LAYOUTS), so it can be planned. */
  hasLayout: boolean;
  /** Our hall standing for it, once mirrored. */
  ourHallId: string | null;
}

export interface ItpoEventDetailView extends ItpoEventView {
  eventHalls: ItpoEventHallView[];
}

/** A hall of ITPO's that an internal event can be given (T_HALLS with a floor). */
export interface ItpoHallView {
  id: string;
  name: string;
  forStallFnb: boolean;
}

interface BookingRow {
  id: string;
  code: string | null;
  name: string | null;
  kind: string | null;
  organiserName: string | null;
  orgId: string | null;
  eventType: string | null;
  productCategory: string | null;
  secondary: boolean | null;
  approvalStatus: string | null;
  bookingStatus: string | null;
  startsOn: string | null;
  endsOn: string | null;
  buildUpOn: string | null;
  dismantleOn: string | null;
  halls: number;
}

/**
 * ITPO's events, read from its own tables, and their mirror here. ITPO stays the source:
 * events (T_HALL_BOOKING) and their halls (T_EVENT_HALL) are listed straight from it; opening
 * one makes or refreshes our event, its halls (floors from T_HALL_LAYOUTS through the ITPO hall
 * import) and their categories, so the planner, rules and review work on them unchanged.
 *
 * Internal events are the ITPO admins' only; an organiser sees the external events of their
 * own organisation (T_HALL_BOOKING.org_id), as ITPO's own booking lists do. Halls are added to
 * an internal event as SelfCare adds them (itpo_stalls_be addHallsForInternalEvent).
 */
@Injectable()
export class ItpoEventsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly hallImport: ItpoHallImportService,
    private readonly events: EventsService,
    private readonly rules: RulesService,
    private readonly audit: AuditService,
  ) {}

  async list(
    access: OrgAccessContext,
    actor: Actor,
    kind: EventKind,
    query: string | undefined,
  ): Promise<ItpoEventView[]> {
    const orgId = await this.organiserOrg(access, actor, kind);
    const params: unknown[] = [HIDDEN_APPROVAL];
    const where = [
      `hb.is_active IS NOT FALSE`,
      `COALESCE(hb.approval_status, '') <> ALL ($1)`,
      `COALESCE(hb.booking_status, '') <> 'Draft'`,
      kind === 'internal'
        ? `hb.event_booking_type = 'internal'`
        : `COALESCE(hb.event_booking_type, '') <> 'internal'`,
    ];
    if (orgId) {
      params.push(orgId);
      where.push(`hb.org_id = $${params.length}`);
    }
    if (query?.trim()) {
      params.push(`%${query.trim()}%`);
      where.push(
        `(hb.event_name ILIKE $${params.length} OR hb.booking_id ILIKE $${params.length} OR hb.organiser_name ILIKE $${params.length})`,
      );
    }
    const rows = await this.bookings(where.join(' AND '), params, LIST_LIMIT);
    const mirrored = await this.mirroredEvents(
      access.organisation.id,
      rows.map((r) => r.id),
    );
    return rows.map((r) => ItpoEventsService.view(r, mirrored.get(r.id) ?? null));
  }

  async get(access: OrgAccessContext, actor: Actor, id: string): Promise<ItpoEventDetailView> {
    const row = await this.booking(access, actor, id);
    const halls: Array<{ id: string; hallId: string; name: string; hasLayout: boolean }> =
      await this.dataSource.query(
        `SELECT eh.id,
                eh.hall_id::text AS "hallId",
                COALESCE(h.name, eh.hall_name, 'Hall ' || eh.hall_id) AS name,
                EXISTS (SELECT 1 FROM idp."T_HALL_LAYOUTS" l WHERE l.hall_id = eh.hall_id) AS "hasLayout"
           FROM idp."T_EVENT_HALL" eh
           LEFT JOIN idp."T_HALLS" h ON h.id = eh.hall_id
          WHERE eh.booking_id = $1
          ORDER BY name`,
        [id],
      );
    const ours = await this.refs(
      access.organisation.id,
      'hall',
      halls.map((h) => h.hallId),
    );
    const mirrored = await this.mirroredEvents(access.organisation.id, [id]);
    return {
      ...ItpoEventsService.view(row, mirrored.get(id) ?? null),
      eventHalls: halls.map((h) => ({ ...h, ourHallId: ours.get(h.hallId) ?? null })),
    };
  }

  /** ITPO's halls an internal event can be given: active, with a floor to plan on. */
  async halls(access: OrgAccessContext): Promise<ItpoHallView[]> {
    if (EventsService.isOrganiser(access)) {
      throw new ForbiddenException('ITPO adds the halls of an event.');
    }
    return this.dataSource.query(
      `SELECT h.id::text AS id, h.name, COALESCE(h.for_stall_fnb, false) AS "forStallFnb"
         FROM idp."T_HALLS" h
        WHERE h.is_active = true
          AND EXISTS (SELECT 1 FROM idp."T_HALL_LAYOUTS" l WHERE l.hall_id = h.id)
        ORDER BY h.sort_order NULLS LAST, h.name`,
    );
  }

  /**
   * Adds an ITPO hall to an internal event, as SelfCare does: a T_EVENT_HALL row, and for a
   * food & beverage hall its F&B categories (T_HALL_CATEGORY_MAPPING). Then the event is
   * opened again here, so the new hall is ready to plan.
   */
  async addHall(
    access: OrgAccessContext,
    actor: Actor,
    id: string,
    hallId: string,
    forStallFnb: boolean,
  ): Promise<ItpoEventDetailView> {
    if (EventsService.isOrganiser(access)) {
      throw new ForbiddenException('ITPO adds the halls of an event.');
    }
    const row = await this.booking(access, actor, id);
    if (row.kind !== 'internal') {
      throw new BadRequestException(
        "Halls are added to internal events here; an organiser's halls come with the booking.",
      );
    }
    const [hall] = await this.dataSource.query(
      `SELECT h.id, h.name FROM idp."T_HALLS" h
        WHERE h.id = $1 AND h.is_active = true
          AND EXISTS (SELECT 1 FROM idp."T_HALL_LAYOUTS" l WHERE l.hall_id = h.id)`,
      [Number(hallId)],
    );
    if (!hall) throw new NotFoundException('ITPO has no such hall with a floor to plan on.');
    await this.dataSource.transaction(async (em) => {
      const added = await em.query(
        `SELECT 1 FROM idp."T_EVENT_HALL" WHERE booking_id = $1 AND hall_id = $2`,
        [id, hall.id],
      );
      if (added.length) throw new ConflictException(`${hall.name} is already in this event.`);
      const [eventHall] = await em.query(
        `INSERT INTO idp."T_EVENT_HALL" (booking_id, hall_id, hall_name, is_stall_fnb, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id`,
        [id, hall.id, hall.name, forStallFnb],
      );
      if (forStallFnb) {
        await em.query(
          `INSERT INTO idp."T_HALL_CATEGORY_MAPPING" (hall_id, product_category_id)
           SELECT $1, cm.id
             FROM idp."T_CODE_TYPE" ct
             JOIN idp."T_CODE_MASTER" cm ON cm."typeId" = ct.id
            WHERE ct.slug = 'f&b'`,
          [eventHall.id],
        );
      }
    });
    await this.audit.record({
      action: 'itpo.event_hall_added',
      actor,
      organisationId: access.organisation.id,
      targetType: 'event',
      targetId: id,
      metadata: { event: row.name, hall: hall.name, forStallFnb },
    });
    await this.open(access, actor, id);
    return this.get(access, actor, id);
  }

  /**
   * Makes or refreshes our mirror of the ITPO event: the event, its halls that have a floor,
   * their categories; an organiser is given the event. Returns our event's id.
   */
  async open(access: OrgAccessContext, actor: Actor, id: string): Promise<{ eventId: string }> {
    const row = await this.booking(access, actor, id);
    const organisationId = access.organisation.id;
    const eventHalls: Array<{ id: string; hallId: string; name: string }> =
      await this.dataSource.query(
        `SELECT eh.id, eh.hall_id::text AS "hallId", COALESCE(h.name, eh.hall_name) AS name
           FROM idp."T_EVENT_HALL" eh
           JOIN idp."T_HALLS" h ON h.id = eh.hall_id
          WHERE eh.booking_id = $1
            AND EXISTS (SELECT 1 FROM idp."T_HALL_LAYOUTS" l WHERE l.hall_id = eh.hall_id)`,
        [id],
      );
    const halls = await this.mirrorHalls(
      organisationId,
      actor,
      eventHalls.map((h) => ({ externalId: h.hallId, name: h.name })),
    );
    const orgRules = await this.rules.get(organisationId);

    const eventId = await this.dataSource.transaction(async (em) => {
      const event = await this.mirrorEvent(em, organisationId, row, actor);
      const repo = em.getRepository(EventHallEntity);
      const existing = await repo.findBy({ eventId: event.id });
      for (const eh of eventHalls) {
        const hall = halls.get(eh.hallId);
        if (!hall) continue;
        let ours = existing.find((e) => e.hallId === hall.id);
        if (!ours) {
          ours = await repo.save(
            repo.create({
              eventId: event.id,
              hallId: hall.id,
              floorVersion: hall.currentVersion,
              ruleSwitches: orgRules.switches,
              ruleValues: orgRules.values,
              drawingProfile: orgRules.drawingProfile,
            }),
          );
        }
        await setExternalId(
          em,
          { organisationId, system: 'itpo', entityType: 'event_hall', localId: ours.id },
          eh.id,
        );
        await this.mirrorCategories(em, organisationId, row, eh.id, ours.id);
      }
      if (EventsService.isOrganiser(access)) {
        await this.giveEvent(em, access, event.id);
      }
      return event.id;
    });
    return { eventId };
  }

  /**
   * The categories an ITPO event's halls may sell, as SelfCare offers them: those of the event's
   * product category (and the secondary ones when enabled). Ours, made the first time.
   */
  async categoryOptions(
    access: OrgAccessContext,
    actor: Actor,
    eventId: string,
  ): Promise<Array<{ id: string; name: string; status: 'active' }>> {
    const row = await this.booking(access, actor, await this.itpoIdOf(access, eventId));
    return this.dataSource.transaction(async (em) => {
      const codes = await this.eventCodes(em, row);
      const ours = await this.ensureCategories(em, access.organisation.id, codes);
      const named = await em
        .getRepository(StallCategoryEntity)
        .findBy({ id: In([...ours.values()]) });
      const byId = new Map(named.map((c) => [c.id, c.name]));
      return [...ours.values()].map((id) => ({ id, name: byId.get(id) ?? '', status: 'active' }));
    });
  }

  /**
   * Sets what an internal ITPO event's hall sells: here (refused when the plan uses a category
   * taken off), then in ITPO as SelfCare's hall list does (T_HALL_CATEGORY_MAPPING).
   */
  async setHallCategories(
    access: OrgAccessContext,
    actor: Actor,
    eventId: string,
    hallId: string,
    categoryIds: string[],
  ): Promise<void> {
    if (EventsService.isOrganiser(access)) {
      throw new ForbiddenException('ITPO sets what a hall sells.');
    }
    const row = await this.booking(access, actor, await this.itpoIdOf(access, eventId));
    if (row.kind !== 'internal') {
      throw new BadRequestException("An organiser's halls sell the categories of their booking.");
    }
    await this.events.setHallCategories(access, eventId, hallId, categoryIds, actor);
    const organisationId = access.organisation.id;
    const { row: eventHall } = await this.events.eventHallOf(access, eventId, hallId);
    const [itpoEventHallId] = [
      ...(await this.refs(organisationId, 'event_hall', [], [eventHall.id])).keys(),
    ];
    if (!itpoEventHallId) throw new NotFoundException('This hall is not one of ITPO’s.');
    const itpoIds = [...(await this.refs(organisationId, 'category', [], categoryIds)).keys()].map(
      Number,
    );
    await this.dataSource.transaction(async (em) => {
      const current: number[] = (
        await em.query(
          `SELECT product_category_id AS id FROM idp."T_HALL_CATEGORY_MAPPING" WHERE hall_id = $1`,
          [itpoEventHallId],
        )
      ).map((r: { id: number }) => Number(r.id));
      const added = itpoIds.filter((id) => !current.includes(id));
      const removed = current.filter((id) => !itpoIds.includes(id));
      if (added.length) {
        await em.query(
          `INSERT INTO idp."T_HALL_CATEGORY_MAPPING" (hall_id, product_category_id, created_at, updated_at)
           SELECT $1, unnest($2::int[]), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP`,
          [itpoEventHallId, added],
        );
      }
      if (removed.length) {
        await em.query(
          `DELETE FROM idp."T_HALL_CATEGORY_MAPPING" WHERE hall_id = $1 AND product_category_id = ANY ($2::int[])`,
          [itpoEventHallId, removed],
        );
      }
    });
  }

  // ---- helpers ------------------------------------------------------------------------------

  /** ITPO's id of one of our events mirrored from ITPO. */
  private async itpoIdOf(access: OrgAccessContext, eventId: string): Promise<string> {
    const event = await this.dataSource
      .getRepository(EventEntity)
      .findOneBy({ id: eventId, organisationId: access.organisation.id });
    if (!event?.venueEventId) throw new NotFoundException('This event is not one of ITPO’s.');
    return event.venueEventId;
  }

  /** The organiser's ITPO organisation, or null for ITPO's admins; refuses an organiser internal events. */
  private async organiserOrg(
    access: OrgAccessContext,
    actor: Actor,
    kind: EventKind,
  ): Promise<string | null> {
    if (!EventsService.isOrganiser(access)) return null;
    if (kind === 'internal') {
      throw new ForbiddenException("Internal events are ITPO's own.");
    }
    const user = await this.dataSource.getRepository(UserEntity).findOneBy({ id: actor.id });
    if (!user?.itpoOrgId) {
      throw new ForbiddenException('This account is not an organiser of ITPO.');
    }
    return user.itpoOrgId;
  }

  /** One ITPO event this member may see; not found either way, so ids reveal nothing. */
  private async booking(access: OrgAccessContext, actor: Actor, id: string): Promise<BookingRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Event not found.');
    const [row] = await this.bookings(`hb.id = $1 AND hb.is_active IS NOT FALSE`, [id], 1);
    if (!row) throw new NotFoundException('Event not found.');
    const kind: EventKind = row.kind === 'internal' ? 'internal' : 'external';
    const orgId = EventsService.isOrganiser(access)
      ? await this.organiserOrg(access, actor, kind)
      : null;
    if (orgId && row.orgId !== orgId) throw new NotFoundException('Event not found.');
    return row;
  }

  private bookings(where: string, params: unknown[], limit: number): Promise<BookingRow[]> {
    return this.dataSource.query(
      `SELECT hb.id,
              hb.booking_id AS code,
              hb.event_name AS name,
              hb.event_booking_type AS kind,
              hb.organiser_name AS "organiserName",
              hb.org_id AS "orgId",
              hb.event_type AS "eventType",
              hb.product_category AS "productCategory",
              hb.is_secondary_enabled AS secondary,
              hb.approval_status AS "approvalStatus",
              hb.booking_status AS "bookingStatus",
              to_char(COALESCE(MIN(eh.exhibition_period_from_date), hb.exhibition_period_from_date::date,
                               hb.tenancy_period_start_date::date), 'YYYY-MM-DD') AS "startsOn",
              to_char(COALESCE(MAX(eh.exhibition_period_to_date), hb.exhibition_period_to_date::date,
                               hb.tenancy_period_end_date::date), 'YYYY-MM-DD') AS "endsOn",
              to_char(MIN(eh.mounting_period_from_date), 'YYYY-MM-DD') AS "buildUpOn",
              to_char(MAX(eh.dismantling_period_to_date), 'YYYY-MM-DD') AS "dismantleOn",
              COUNT(eh.id)::int AS halls
         FROM idp."T_HALL_BOOKING" hb
         LEFT JOIN idp."T_EVENT_HALL" eh ON eh.booking_id = hb.id
        WHERE ${where}
        GROUP BY hb.id
        ORDER BY COALESCE(MIN(eh.exhibition_period_from_date), hb.tenancy_period_start_date::date) DESC NULLS LAST,
                 hb.booking_date DESC NULLS LAST
        LIMIT ${limit}`,
      params,
    );
  }

  /** Our events standing for these ITPO events, by ITPO's id. */
  private async mirroredEvents(
    organisationId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const events = await this.dataSource
      .getRepository(EventEntity)
      .findBy({ organisationId, venueEventId: In(ids) });
    return new Map(events.map((e) => [e.venueEventId!, e.id]));
  }

  /** Our ids for ITPO ids of one kind of record. */
  /** Our ids by ITPO's, found by ITPO's ids or (`localIds`) by ours. */
  private async refs(
    organisationId: string,
    entityType: 'hall' | 'event_hall' | 'category',
    externalIds: string[],
    localIds: string[] = [],
  ): Promise<Map<string, string>> {
    if (!externalIds.length && !localIds.length) return new Map();
    const refs = await this.dataSource.getRepository(ExternalRefEntity).findBy({
      organisationId,
      system: 'itpo',
      entityType,
      ...(localIds.length ? { localId: In(localIds) } : { externalId: In(externalIds) }),
    });
    return new Map(refs.map((r) => [r.externalId, r.localId]));
  }

  /**
   * Our halls for these ITPO halls, made or refreshed from T_HALL_LAYOUTS through the ITPO hall
   * import (a changed floor becomes a new floor version; an unchanged one is left be).
   */
  private async mirrorHalls(
    organisationId: string,
    actor: Actor,
    wanted: Array<{ externalId: string; name: string }>,
  ): Promise<Map<string, HallEntity>> {
    if (!wanted.length) return new Map();
    const rows = await this.dataSource.query(
      `SELECT l.id, l.hall_id, h.name, l.length, l.breadth, l.layout_data, l.legends,
              l.helper_text, l.exit_labels, l.direction, l.default_stalls
         FROM idp."T_HALL_LAYOUTS" l
         JOIN idp."T_HALLS" h ON h.id = l.hall_id
        WHERE l.hall_id = ANY ($1::int[])`,
      [wanted.map((w) => Number(w.externalId))],
    );
    if (rows.length) {
      const venue = await this.venue(organisationId);
      await this.hallImport.import(
        organisationId,
        venue.id,
        {
          format: 'json',
          content: JSON.stringify(rows),
          halls: rows.map((r: { hall_id: number; name: string }) => ({
            externalId: String(r.hall_id),
            name: (r.name ?? `Hall ${r.hall_id}`).slice(0, 120),
          })),
        },
        actor,
      );
    }
    const ids = await this.refs(
      organisationId,
      'hall',
      wanted.map((w) => w.externalId),
    );
    const halls = await this.dataSource
      .getRepository(HallEntity)
      .findBy({ id: In([...ids.values()]) });
    const byId = new Map(halls.map((h) => [h.id, h]));
    return new Map(
      [...ids].flatMap(([ext, local]) => (byId.has(local) ? [[ext, byId.get(local)!]] : [])),
    );
  }

  /** The venue ITPO's halls are kept in here. */
  private async venue(organisationId: string): Promise<VenueEntity> {
    const repo = this.dataSource.getRepository(VenueEntity);
    return (
      (await repo.findOneBy({ organisationId, name: VENUE_NAME })) ??
      repo.save(repo.create({ organisationId, name: VENUE_NAME, code: 'BM' }))
    );
  }

  private async mirrorEvent(
    em: EntityManager,
    organisationId: string,
    row: BookingRow,
    actor: Actor,
  ): Promise<EventEntity> {
    const repo = em.getRepository(EventEntity);
    const kind: EventKind = row.kind === 'internal' ? 'internal' : 'external';
    const startsOn = row.startsOn ?? new Date().toISOString().slice(0, 10);
    const endsOn = row.endsOn && row.endsOn >= startsOn ? row.endsOn : startsOn;
    const fields = {
      kind,
      name: (row.name?.trim() || row.code || 'ITPO event').slice(0, 160),
      organiserName: row.organiserName?.trim().slice(0, 160) || null,
      audience: ItpoEventsService.audience(row.eventType),
      startsOn,
      endsOn,
      buildUpOn: row.buildUpOn && row.buildUpOn <= startsOn ? row.buildUpOn : null,
      dismantleOn: row.dismantleOn && row.dismantleOn >= endsOn ? row.dismantleOn : null,
    };
    const existing = await repo.findOneBy({ organisationId, venueEventId: row.id });
    if (existing) {
      Object.assign(existing, fields);
      return repo.save(existing);
    }
    // ITPO books and bills the stalls: the event sells through ITPO's own system.
    return repo.save(
      repo.create({
        organisationId,
        venueEventId: row.id,
        ...fields,
        status: 'scheduled',
        bookingChannel: 'venue_system',
        createdById: actor.id,
      }),
    );
  }

  /**
   * The event hall's categories as ITPO has them: the hall's own (T_HALL_CATEGORY_MAPPING, set
   * in SelfCare's hall list), else those of the event's product category (T_HALL_BOOKING
   * .product_category, and the secondary categories when enabled), as the booking has them.
   * Each ITPO category (T_CODE_MASTER) is one of ours, kept by its id.
   */
  private async mirrorCategories(
    em: EntityManager,
    organisationId: string,
    row: BookingRow,
    itpoEventHallId: string,
    eventHallId: string,
  ): Promise<void> {
    let codes: Array<{ id: number; name: string; type: string }> = await em.query(
      `SELECT cm.id, cm.name, ct.name AS type
         FROM idp."T_HALL_CATEGORY_MAPPING" m
         JOIN idp."T_CODE_MASTER" cm ON cm.id = m.product_category_id
         JOIN idp."T_CODE_TYPE" ct ON ct.id = cm."typeId"
        WHERE m.hall_id = $1 AND m.is_active IS NOT FALSE`,
      [itpoEventHallId],
    );
    if (!codes.length) codes = await this.eventCodes(em, row);
    const links = em.getRepository(EventHallCategoryEntity);
    const ours = await this.ensureCategories(em, organisationId, codes);
    const wanted = new Set(ours.values());
    for (const categoryId of wanted) {
      await links
        .createQueryBuilder()
        .insert()
        .values({ eventHallId, categoryId })
        .orIgnore()
        .execute();
    }
    // What ITPO no longer gives the hall goes, unless the plan's stalls or seats use it.
    await em.query(
      `DELETE FROM event_hall_categories l
        WHERE l.event_hall_id = $1
          AND NOT (l.category_id = ANY ($2::uuid[]))
          AND NOT EXISTS (
            SELECT 1 FROM stall_plans p
              JOIN plan_stalls s ON s.plan_id = p.id
             WHERE p.event_hall_id = l.event_hall_id AND l.category_id = ANY (s.category_ids))
          AND NOT EXISTS (
            SELECT 1 FROM stall_plans p
              JOIN plan_seats s ON s.plan_id = p.id
             WHERE p.event_hall_id = l.event_hall_id AND s.category_id = l.category_id)`,
      [eventHallId, [...wanted]],
    );
  }

  /** The event's categories as its booking has them: its product category, and the secondary ones when enabled. */
  private eventCodes(
    em: EntityManager,
    row: Pick<BookingRow, 'productCategory' | 'secondary'>,
  ): Promise<Array<{ id: number; name: string; type: string }>> {
    return em.query(
      `SELECT cm.id, cm.name, ct.name AS type
         FROM idp."T_CODE_TYPE" ct
         JOIN idp."T_CODE_MASTER" cm ON cm."typeId" = ct.id
        WHERE ct.slug = $1 OR (ct.slug = 'secondary_category' AND $2)
        ORDER BY ct.slug = 'secondary_category', cm.name`,
      [row.productCategory ?? '', !!row.secondary],
    );
  }

  /**
   * Our categories for ITPO's (T_CODE_MASTER), made the first time: one of ours per ITPO
   * category, kept by its id. Returns ours by ITPO's id.
   */
  private async ensureCategories(
    em: EntityManager,
    organisationId: string,
    codes: Array<{ id: number; name: string; type: string }>,
  ): Promise<Map<string, string>> {
    const categories = em.getRepository(StallCategoryEntity);
    const linked = await this.refsIn(
      em,
      organisationId,
      codes.map((c) => String(c.id)),
    );
    const out = new Map<string, string>();
    for (const code of codes) {
      // ITPO's names carry stray spaces and line breaks.
      const plain = code.name.replace(/\s+/g, ' ').trim();
      let categoryId = linked.get(String(code.id));
      if (!categoryId) {
        const taken = await categories
          .createQueryBuilder('c')
          .where('c.organisation_id = :organisationId AND lower(c.name) = lower(:name)', {
            organisationId,
            name: plain,
          })
          .getOne();
        const name = (taken ? `${plain} · ${code.type.trim()}` : plain).slice(0, 160);
        const made = await categories.save(
          categories.create({ organisationId, name, status: 'active' }),
        );
        await setExternalId(
          em,
          { organisationId, system: 'itpo', entityType: 'category', localId: made.id },
          String(code.id),
        );
        categoryId = made.id;
      }
      out.set(String(code.id), categoryId);
    }
    return out;
  }

  private async refsIn(
    em: EntityManager,
    organisationId: string,
    externalIds: string[],
  ): Promise<Map<string, string>> {
    if (!externalIds.length) return new Map();
    const refs = await em.getRepository(ExternalRefEntity).findBy({
      organisationId,
      system: 'itpo',
      entityType: 'category',
      externalId: In(externalIds),
    });
    return new Map(refs.map((r) => [r.externalId, r.localId]));
  }

  /** Gives the organiser the event: it joins their membership's events. */
  private async giveEvent(
    em: EntityManager,
    access: OrgAccessContext,
    eventId: string,
  ): Promise<void> {
    const scope = access.membership.scope ?? {};
    const eventIds = scope.eventIds ?? [];
    if (eventIds.includes(eventId)) return;
    await em.query(`UPDATE memberships SET scope = $1 WHERE id = $2`, [
      { ...scope, eventIds: [...eventIds, eventId] },
      access.membership.id,
    ]);
  }

  /** B2C when the event lets the public in (the stricter rules), else B2B. */
  static audience(eventType: string | null): EventType {
    return /b2c/i.test(eventType ?? '') ? 'B2C' : 'B2B';
  }

  private static view(row: BookingRow, eventId: string | null): ItpoEventView {
    return {
      id: row.id,
      code: row.code,
      name: row.name?.trim() || row.code || 'ITPO event',
      kind: row.kind === 'internal' ? 'internal' : 'external',
      organiserName: row.organiserName,
      startsOn: row.startsOn,
      endsOn: row.endsOn,
      approvalStatus: row.approvalStatus,
      bookingStatus: row.bookingStatus,
      halls: row.halls,
      eventId,
    };
  }
}
