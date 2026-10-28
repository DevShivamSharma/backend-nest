import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { AuditService } from '../../audit/audit.service';
import type { SessionUser } from '../../auth/domain/session-user';
import { UserType } from '../../auth/domain/user-type';
import { DRAWING_PROFILES, drawingProfile } from '../domain/drawing-profiles';
import type { SetEventRulesDto, UpdateRulesDto } from '../dto/rules.dto';
import {
  DEFAULT_RULE_VALUES,
  effectiveValues,
  RULE_IDS,
  RuleId,
  RULES,
  RuleSwitches,
  RuleValues,
  VALUE_LIMITS,
  valueProblems,
} from '../domain/rule-catalogue';

export interface RuleReference {
  document: string;
  section?: string | null;
  note?: string | null;
}

export interface RulesView {
  switches: Record<RuleId, boolean>;
  values: RuleValues;
  references: RuleReference[];
  drawingProfile: string;
  updatedAt: string;
}

export interface HallRulesView {
  hall: { id: number; name: string };
  /** Each rule as this hall has it: `overridden` says ITPO changed it for the hall. */
  rules: { id: RuleId; enabled: boolean; defaultEnabled: boolean; overridden: boolean }[];
  values: RuleValues;
}

export interface EventRulesView {
  event: { id: string; name: string | null; kind: 'internal' | 'external' };
  /** Each rule as this event has it: `enabled` is what applies; `overridden` says the event changed it. */
  rules: { id: RuleId; enabled: boolean; defaultEnabled: boolean; overridden: boolean }[];
  values: RuleValues;
}

interface RuleSetRow {
  switches: RuleSwitches;
  rule_values: Partial<RuleValues>;
  doc_references: RuleReference[];
  drawing_profile: string;
  updated_at: Date;
}

interface EventRow {
  id: string;
  event_name: string | null;
  event_booking_type: string | null;
  org_id: string | null;
}

/**
 * The planning rules. One set applies to every hall; ITPO staff change it. An event can switch
 * rules off (or back on) for itself, whether it is an internal ITPO event or an organiser's
 * external one; the values (widths, clearances) stay the set's.
 */
@Injectable()
export class RulesService {
  constructor(
    private readonly db: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** The rules that can be checked, the limits on their values, and the drawing profiles. */
  catalogue() {
    return { rules: RULES, limits: VALUE_LIMITS, profiles: DRAWING_PROFILES };
  }

  // ---- the rule set, for every hall -----------------------------------------------------------

  async get(): Promise<RulesView> {
    return view(await this.ruleSet(this.db.manager));
  }

  async update(dto: UpdateRulesDto, user: SessionUser): Promise<RulesView> {
    const saved = await this.db.transaction(async (tx) => {
      const rules = await this.ruleSet(tx, true);

      if (dto.switches !== undefined) {
        rules.switches = switchesFrom(dto.switches);
      }
      if (dto.values !== undefined) {
        const values = effectiveValues({
          ...dto.values,
          // A client that predates the Pillars rule keeps the clearance there is.
          pillarClearance:
            dto.values.pillarClearance ??
            rules.rule_values?.pillarClearance ??
            DEFAULT_RULE_VALUES.pillarClearance,
        });
        const problems = valueProblems(values);
        if (problems.length) {
          throw new BadRequestException(problems.join(' '));
        }
        rules.rule_values = values;
      }
      if (dto.references !== undefined) {
        rules.doc_references = dto.references.map((r) => ({
          document: r.document,
          section: r.section ?? null,
          note: r.note ?? null,
        }));
      }
      if (dto.drawingProfile !== undefined) {
        if (!drawingProfile(dto.drawingProfile)) {
          throw new BadRequestException(`"${dto.drawingProfile}" is not a drawing profile.`);
        }
        rules.drawing_profile = dto.drawingProfile;
      }

      // TypeORM answers an UPDATE ... RETURNING as [rows, affected count].
      const [[saved]] = await tx.query<[RuleSetRow[], number]>(
        `UPDATE idp."T_RULE_SET"
            SET switches = $1::jsonb, rule_values = $2::jsonb, doc_references = $3::jsonb,
                drawing_profile = $4, updated_by = $5, updated_at = NOW()
          WHERE id = 1
        RETURNING switches, rule_values, doc_references, drawing_profile, updated_at`,
        [
          JSON.stringify(rules.switches),
          JSON.stringify(rules.rule_values),
          JSON.stringify(rules.doc_references),
          rules.drawing_profile,
          user.id,
        ],
      );
      return view(saved);
    });
    const parts = [
      dto.switches !== undefined && 'rules switched',
      dto.values !== undefined && 'values',
      dto.references !== undefined && 'documents',
      dto.drawingProfile !== undefined && 'drawing profile',
    ].filter(Boolean);
    await this.audit.record(user, { action: 'rules.changed', detail: parts.join(', ') || null });
    return saved;
  }

  // ---- one event's switches ---------------------------------------------------------------

  /** The rules as an event has them. An organiser sees only their own events. */
  async forEvent(eventId: string, user: SessionUser): Promise<EventRulesView> {
    return this.eventView(this.db.manager, eventId, user);
  }

  /**
   * Switches rules off or on for one event (null: follow the default again). The same for an
   * internal and an external event; planning stalls for an organiser is not part of this.
   */
  async setForEvent(
    eventId: string,
    dto: SetEventRulesDto,
    user: SessionUser,
  ): Promise<EventRulesView> {
    let eventName: string | null = null;
    const saved = await this.db.transaction(async (tx) => {
      const event = await this.event(tx, eventId, user);
      eventName = event.event_name;
      if (event.event_booking_type === 'internal') {
        throw new BadRequestException('The rules are always off for an internal event.');
      }

      for (const [key, value] of Object.entries(dto.switches)) {
        if (!(RULE_IDS as readonly string[]).includes(key)) {
          throw new BadRequestException(`"${key}" is not a rule.`);
        }
        if (value !== null && typeof value !== 'boolean') {
          throw new BadRequestException(`Switch "${key}" must be on, off or null.`);
        }
      }

      for (const [key, value] of Object.entries(dto.switches)) {
        if (value === null) {
          await tx.query(
            `DELETE FROM idp."T_EVENT_RULE_SWITCH" WHERE event_id = $1 AND rule_id = $2`,
            [eventId, key],
          );
        } else {
          await tx.query(
            `INSERT INTO idp."T_EVENT_RULE_SWITCH" (event_id, rule_id, enabled, updated_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (event_id, rule_id)
             DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
            [eventId, key, value, user.id],
          );
        }
      }

      return this.eventView(tx, eventId, user);
    });
    await this.audit.record(user, {
      action: 'rules.event_changed',
      event: { id: eventId, name: eventName },
      detail: Object.entries(dto.switches)
        .map(([rule, on]) => `${rule}: ${on === null ? 'default' : on ? 'on' : 'off'}`)
        .join(', ')
        .slice(0, 900),
    });
    return saved;
  }

  /**
   * What applies to an event hall: the default switches, then the hall's own, then the event's.
   * ITPO's own (internal) events have every rule off.
   */
  async effective(
    em: EntityManager,
    eventId: string,
    hallId?: number,
  ): Promise<{ switches: RuleSwitches; values: RuleValues; drawingProfile: string }> {
    const rules = await this.ruleSet(em);
    const [booking] = await em.query<{ event_booking_type: string | null }[]>(
      `SELECT event_booking_type FROM idp."T_HALL_BOOKING" WHERE id = $1`,
      [eventId],
    );
    // ITPO plans its own events freely: no rule applies, whatever the default says.
    const internal = booking?.event_booking_type === 'internal';
    const overrides = internal
      ? []
      : await em.query<{ rule_id: RuleId; enabled: boolean }[]>(
          `SELECT rule_id, enabled FROM idp."T_EVENT_RULE_SWITCH" WHERE event_id = $1`,
          [eventId],
        );
    const hallOwn =
      internal || hallId === undefined ? new Map() : await this.hallOverrides(em, hallId);
    const own = new Map(overrides.map((o) => [o.rule_id, o.enabled]));
    const switches: RuleSwitches = {};
    for (const id of RULE_IDS) {
      switches[id] = internal
        ? false
        : (own.get(id) ?? hallOwn.get(id) ?? rules.switches?.[id] !== false);
    }
    return {
      switches,
      values: effectiveValues(rules.rule_values),
      drawingProfile: rules.drawing_profile,
    };
  }

  // ---- one hall's switches ----------------------------------------------------------------

  /** The rules as a hall has them: the default, and what ITPO switched for this hall. */
  async forHall(hallId: number): Promise<HallRulesView> {
    return this.hallView(this.db.manager, hallId);
  }

  /** ITPO staff switch rules off or on for one hall (null: follow the default again). */
  async setForHall(
    hallId: number,
    dto: SetEventRulesDto,
    user: SessionUser,
  ): Promise<HallRulesView> {
    for (const [key, value] of Object.entries(dto.switches)) {
      if (!(RULE_IDS as readonly string[]).includes(key)) {
        throw new BadRequestException(`"${key}" is not a rule.`);
      }
      if (value !== null && typeof value !== 'boolean') {
        throw new BadRequestException(`Switch "${key}" must be on, off or null.`);
      }
    }
    let hallName: string | null = null;
    const saved = await this.db.transaction(async (tx) => {
      hallName = (await this.hallName(tx, hallId)).name;
      for (const [key, value] of Object.entries(dto.switches)) {
        if (value === null) {
          await tx.query(
            `DELETE FROM idp."T_HALL_RULE_SWITCH" WHERE hall_id = $1 AND rule_id = $2`,
            [hallId, key],
          );
        } else {
          await tx.query(
            `INSERT INTO idp."T_HALL_RULE_SWITCH" (hall_id, rule_id, enabled, updated_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (hall_id, rule_id)
             DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
            [hallId, key, value, user.id],
          );
        }
      }
      return this.hallView(tx, hallId);
    });
    await this.audit.record(user, {
      action: 'rules.hall_changed',
      hall: { id: String(hallId), name: hallName },
      detail: Object.entries(dto.switches)
        .map(([rule, on]) => `${rule}: ${on === null ? 'default' : on ? 'on' : 'off'}`)
        .join(', ')
        .slice(0, 900),
    });
    return saved;
  }

  private async hallOverrides(em: EntityManager, hallId: number): Promise<Map<RuleId, boolean>> {
    const rows = await em.query<{ rule_id: RuleId; enabled: boolean }[]>(
      `SELECT rule_id, enabled FROM idp."T_HALL_RULE_SWITCH" WHERE hall_id = $1`,
      [hallId],
    );
    return new Map(rows.map((r) => [r.rule_id, r.enabled]));
  }

  private async hallName(em: EntityManager, hallId: number): Promise<{ id: number; name: string }> {
    const [hall] = await em.query<{ id: number; name: string }[]>(
      `SELECT id, name FROM idp."T_HALLS" WHERE id = $1`,
      [hallId],
    );
    if (!hall) throw new NotFoundException('Hall not found.');
    return hall;
  }

  private async hallView(em: EntityManager, hallId: number): Promise<HallRulesView> {
    const hall = await this.hallName(em, hallId);
    const rules = await this.ruleSet(em);
    const own = await this.hallOverrides(em, hallId);
    return {
      hall: { id: hall.id, name: hall.name },
      rules: RULE_IDS.map((id) => {
        const defaultEnabled = rules.switches?.[id] !== false;
        return {
          id,
          enabled: own.get(id) ?? defaultEnabled,
          defaultEnabled,
          overridden: own.has(id),
        };
      }),
      values: effectiveValues(rules.rule_values),
    };
  }

  // ---- helpers ----------------------------------------------------------------------------

  private async eventView(
    em: EntityManager,
    eventId: string,
    user: SessionUser,
  ): Promise<EventRulesView> {
    const event = await this.event(em, eventId, user);
    const rules = await this.ruleSet(em);
    const internal = event.event_booking_type === 'internal';
    const overrides = internal
      ? []
      : await em.query<{ rule_id: RuleId; enabled: boolean }[]>(
          `SELECT rule_id, enabled FROM idp."T_EVENT_RULE_SWITCH" WHERE event_id = $1`,
          [eventId],
        );
    const own = new Map(overrides.map((o) => [o.rule_id, o.enabled]));

    return {
      event: {
        id: event.id,
        name: event.event_name,
        kind: event.event_booking_type === 'internal' ? 'internal' : 'external',
      },
      rules: RULE_IDS.map((id) => {
        const defaultEnabled = !internal && rules.switches?.[id] !== false;
        return {
          id,
          enabled: own.get(id) ?? defaultEnabled,
          defaultEnabled,
          overridden: own.has(id),
        };
      }),
      values: effectiveValues(rules.rule_values),
    };
  }

  /** ITPO's booking row for the event; an organiser may only reach their own organisation's. */
  private async event(em: EntityManager, eventId: string, user: SessionUser): Promise<EventRow> {
    const [event] = await em.query<EventRow[]>(
      `SELECT id, event_name, event_booking_type, org_id FROM idp."T_HALL_BOOKING" WHERE id = $1`,
      [eventId],
    );
    if (!event) {
      throw new NotFoundException('Event not found.');
    }
    if (user.type === UserType.Organiser && event.org_id !== user.orgId) {
      throw new ForbiddenException('You do not have access to this event.');
    }
    return event;
  }

  private async ruleSet(em: EntityManager, lock = false): Promise<RuleSetRow> {
    const [row] = await em.query<RuleSetRow[]>(
      `SELECT switches, rule_values, doc_references, drawing_profile, updated_at
         FROM idp."T_RULE_SET" WHERE id = 1 ${lock ? 'FOR UPDATE' : ''}`,
    );
    if (!row) {
      throw new NotFoundException('The rule set has not been set up.');
    }
    return row;
  }
}

/** Known rules only; stored as given (a missing switch means on). */
function switchesFrom(input: Record<string, boolean>): RuleSwitches {
  const out: RuleSwitches = {};
  for (const [key, on] of Object.entries(input)) {
    if (!(RULE_IDS as readonly string[]).includes(key)) {
      throw new BadRequestException(`"${key}" is not a rule.`);
    }
    if (typeof on !== 'boolean') {
      throw new BadRequestException(`Switch "${key}" must be on or off.`);
    }
    out[key as RuleId] = on;
  }
  return out;
}

function view(rules: RuleSetRow): RulesView {
  return {
    switches: Object.fromEntries(RULE_IDS.map((r) => [r, rules.switches?.[r] !== false])) as Record<
      RuleId,
      boolean
    >,
    values: effectiveValues(rules.rule_values),
    references: rules.doc_references ?? [],
    // A profile no longer offered reads as no constraints.
    drawingProfile: drawingProfile(rules.drawing_profile)?.id ?? 'free',
    updatedAt: new Date(rules.updated_at).toISOString(),
  };
}
