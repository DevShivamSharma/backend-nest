import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import type { SessionUser } from '../../auth/domain/session-user';
import { UserType } from '../../auth/domain/user-type';
import type { EventType } from '../../rules/domain/rule-catalogue';
import { RulesService } from '../../rules/services/rules.service';
import type { HallFloor } from '../domain/hall-floor';
import { itpoRowToFloor } from '../domain/itpo-hall-layout';
import type { PlanRulesContext } from '../domain/plan-structure';

export type EventKind = 'internal' | 'external';

/** The event hall a plan is for, with the event it belongs to. */
export interface PlanEventHall {
  eventId: string;
  eventName: string;
  kind: EventKind;
  audience: EventType;
  /** ITPO's own approval of the event; an external event is planned once it is "Approved". */
  approvalStatus: string | null;
  cancelled: boolean;
  orgId: string | null;
  organiserName: string | null;
  eventHallId: string;
  hallId: number;
  hallName: string;
  hallCode: string | null;
}

export interface PlanCategory {
  id: string;
  name: string;
}

interface HallRow {
  event_id: string;
  event_name: string | null;
  event_booking_type: string | null;
  event_type: string | null;
  approval_status: string | null;
  booking_status: string | null;
  cancellation_status: string | null;
  org_id: string | null;
  organiser: string | null;
  event_hall_id: string;
  hall_id: string;
  hall_name: string | null;
  hall_code: string | null;
  hall_cancellation: string | null;
}

/** What the planner needs to know about an event hall: who it is for, its floor, its rules and its categories. */
@Injectable()
export class PlanContextService {
  constructor(
    private readonly db: DataSource,
    private readonly rules: RulesService,
  ) {}

  /** The event hall, if the user may see its plan: ITPO staff any, an organiser their own organisation's. */
  async eventHall(
    eventId: string,
    eventHallId: string,
    user: SessionUser,
    em: EntityManager = this.db.manager,
  ): Promise<PlanEventHall> {
    const [row] = await em.query<HallRow[]>(
      `SELECT b.id AS event_id, b.event_name, b.event_booking_type, b.event_type,
              b.approval_status, b.booking_status, b.cancellation_status, b.org_id,
              o.name AS organiser, eh.id AS event_hall_id, eh.hall_id::text AS hall_id,
              eh.hall_name, eh.hall_code, eh.cancellation_status AS hall_cancellation
         FROM idp."T_EVENT_HALL" eh
         JOIN idp."T_HALL_BOOKING" b ON b.id = eh.booking_id
         LEFT JOIN idp."T_ORGANIZATION" o ON o.id = b.org_id
        WHERE eh.id = $2 AND b.id = $1 AND b.is_active = true`,
      [eventId, eventHallId],
    );
    if (!row) {
      throw new NotFoundException('This hall is not part of the event.');
    }
    if (user.type === UserType.Organiser && row.org_id !== user.orgId) {
      throw new ForbiddenException('You do not have access to this event.');
    }
    return {
      eventId: row.event_id,
      eventName: row.event_name ?? '',
      kind: row.event_booking_type === 'internal' ? 'internal' : 'external',
      audience: audienceOf(row.event_type),
      approvalStatus: row.approval_status,
      cancelled:
        row.approval_status === 'Cancelled' ||
        row.cancellation_status === 'Approved' ||
        row.hall_cancellation === 'Approved',
      orgId: row.org_id,
      organiserName: row.organiser,
      eventHallId: row.event_hall_id,
      hallId: Number(row.hall_id),
      hallName: row.hall_name ?? '',
      hallCode: row.hall_code,
    };
  }

  /** The hall's floor as the event keeps it (its own copy), else the hall's own layout. */
  async floor(hall: PlanEventHall, em: EntityManager = this.db.manager): Promise<HallFloor> {
    const [row] = await em.query<Record<string, unknown>[]>(
      `SELECT length, breadth, layout_data, legends, helper_text, exit_labels, direction, default_stalls
         FROM idp."T_EVENT_HALL_LAYOUT_DATA" WHERE event_hall_id = $1
        UNION ALL
       SELECT length, breadth, layout_data, legends, helper_text, exit_labels, direction, default_stalls
         FROM idp."T_HALL_LAYOUTS" WHERE hall_id = $2
        LIMIT 1`,
      [hall.eventHallId, hall.hallId],
    );
    if (!row) {
      throw new NotFoundException('This hall has no layout yet.');
    }
    try {
      return itpoRowToFloor({
        layoutId: null,
        hallId: String(hall.hallId),
        name: hall.hallName,
        length: row['length'],
        breadth: row['breadth'],
        layoutData: row['layout_data'],
        legends: row['legends'],
        helperText: row['helper_text'],
        exitLabels: row['exit_labels'],
        direction: row['direction'],
        defaultStalls: row['default_stalls'],
      }).floor;
    } catch (error) {
      throw new NotFoundException(
        error instanceof Error ? error.message : 'The hall layout could not be read.',
      );
    }
  }

  /** The rules that apply to this event's plan. */
  async rulesOf(
    hall: PlanEventHall,
    em: EntityManager = this.db.manager,
  ): Promise<PlanRulesContext> {
    const [floor, effective] = await Promise.all([
      this.floor(hall, em),
      this.rules.effective(em, hall.eventId, hall.hallId),
    ]);
    // ITPO plans its own events freely, whatever the rule set says.
    const switches =
      hall.kind === 'internal'
        ? (Object.fromEntries(
            Object.keys(effective.switches).map((id) => [id, false]),
          ) as typeof effective.switches)
        : effective.switches;
    return {
      floor,
      switches,
      values: effective.values,
      eventType: hall.audience,
      drawingProfile: effective.drawingProfile,
    };
  }

  /** The categories the event hall sells; the planner offers only these. */
  async categories(
    hall: PlanEventHall,
    em: EntityManager = this.db.manager,
  ): Promise<PlanCategory[]> {
    const rows = await em.query<{ id: number; name: string }[]>(
      `SELECT DISTINCT cm.id, cm.name
         FROM idp."T_HALL_CATEGORY_MAPPING" m
         JOIN idp."T_CODE_MASTER" cm ON cm.id = m.product_category_id
        WHERE m.hall_id = $1 AND m.is_active = true
        ORDER BY cm.name`,
      [hall.eventHallId],
    );
    return rows.map((r) => ({ id: String(r.id), name: r.name }));
  }
}

/** ITPO writes an event's audience in words ("B2B event", "B2B & B2C both"); the rules know two. */
function audienceOf(text: string | null): EventType {
  const t = (text ?? '').toUpperCase();
  return t.includes('B2C') && !t.includes('B2B') ? 'B2C' : 'B2B';
}
