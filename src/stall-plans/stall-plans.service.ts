import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor, OrgAccessContext } from '../common/http/authenticated-request';
import { EventEntity } from '../events/event.entity';
import type { EventHallDetailView } from '../events/event.views';
import { EventsService } from '../events/events.service';
import { drawingProfile } from '../rules/drawing-profiles';
import { ringArea } from '../venues/floor-plan/geometry';
import {
  CheckPlanDto,
  PlanObjectDto,
  PlanSeatDto,
  PlanStallDto,
  PlanZoneDto,
  PublishPlanDto,
  SavePlanDto,
} from './dto/stall-plans.dto';
import { checkPlan, findingsFor, PlanFinding } from './plan-check';
import {
  PlanObjectEntity,
  PlanSeatEntity,
  PlanStallEntity,
  PlanZoneEntity,
  StallPlanEntity,
} from './stall-plan.entity';
import type {
  PlanCheckView,
  PlannerView,
  PlanObjectView,
  PlanSeatView,
  PlanStallView,
  PlanZoneView,
  StallPlanView,
} from './stall-plans.views';

/** Rows per insert: seats come in thousands, and Postgres takes at most 65 535 parameters. */
const CHUNK = 1000;
/** Broken rules named in a refusal; the rest are counted. */
const NAMED = 3;

type PlanContent = {
  zones: PlanZoneDto[];
  stalls: PlanStallDto[];
  seats: PlanSeatDto[];
  objects: PlanObjectDto[];
};

/**
 * The stall plan of an event hall (Module E): zones, stalls and seats on the floor version the
 * event keeps, checked against the rules of that event hall. A change that breaks a rule is
 * refused; there is no setting rules aside in the planner.
 *
 * Who draws: on an internal event the venue's own team, on an external one the organisers the
 * venue invited to it. Both need `layouts.edit`; everyone else with `layouts.view` reads.
 */
@Injectable()
export class StallPlansService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  async get(access: OrgAccessContext, id: string, hallId: string): Promise<PlannerView> {
    const hall = await this.events.hall(access, id, hallId);
    const { event, row } = await this.events.eventHallOf(access, id, hallId);
    const plan = await this.dataSource
      .getRepository(StallPlanEntity)
      .findOneBy({ eventHallId: row.id });
    const readOnlyReason = StallPlansService.readOnlyReason(access, event);
    return {
      hall,
      plan: await this.planView(this.dataSource.manager, plan),
      canEdit: !readOnlyReason,
      readOnlyReason,
      canPublish: !readOnlyReason && access.permissions.includes('layouts.publish'),
    };
  }

  /**
   * Publishes the saved plan: that revision becomes the one that counts. Only a plan with no
   * unsaved changes (the planner's revision is the saved one) that still keeps every rule of
   * the hall, which may have changed since it was saved.
   */
  async publish(
    access: OrgAccessContext,
    id: string,
    hallId: string,
    dto: PublishPlanDto,
    actor: Actor,
  ): Promise<StallPlanView> {
    const { event, row } = await this.events.eventHallOf(access, id, hallId);
    this.assertCanEdit(access, event);
    const hall = await this.events.hall(access, id, hallId);
    return this.dataSource.transaction(async (em) => {
      const plans = em.getRepository(StallPlanEntity);
      const plan = await plans.findOne({
        where: { eventHallId: row.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!plan || plan.revision === 0) {
        throw new BadRequestException('Save the plan before publishing it.');
      }
      if (plan.revision !== dto.revision) {
        throw new ConflictException(
          'The saved plan changed after you opened it. Reload the planner, then publish.',
        );
      }
      const saved = await this.planView(em, plan);
      const problems = [
        ...StallPlansService.structure(saved, hall),
        ...StallPlansService.rules(saved, hall),
      ];
      if (problems.length) {
        throw new BadRequestException(
          StallPlansService.refusal(problems).replace('was not saved', 'was not published'),
        );
      }
      plan.publishedRevision = plan.revision;
      plan.publishedAt = new Date();
      plan.publishedById = actor.id;
      const published = await plans.save(plan);
      await this.audit.record(
        {
          action: 'plan.published',
          actor,
          organisationId: access.organisation.id,
          targetType: 'event',
          targetId: event.id,
          metadata: {
            name: event.name,
            hall: hall.hall.name,
            revision: plan.revision,
            stalls: saved.stalls.length,
          },
        },
        em,
      );
      return { ...saved, published: StallPlansService.published(published) };
    });
  }

  /** The rules the planner's change breaks: those about `changed`, or about the whole plan. */
  async check(
    access: OrgAccessContext,
    id: string,
    hallId: string,
    dto: CheckPlanDto,
  ): Promise<PlanCheckView> {
    const { event } = await this.events.eventHallOf(access, id, hallId);
    this.assertCanEdit(access, event);
    const hall = await this.events.hall(access, id, hallId);
    const all = [...StallPlansService.structure(dto, hall), ...StallPlansService.rules(dto, hall)];
    return { findings: findingsFor(all, new Set(dto.changed)) };
  }

  /** Replaces the saved plan with this one, when nothing in it breaks a rule. */
  async save(
    access: OrgAccessContext,
    id: string,
    hallId: string,
    dto: SavePlanDto,
    actor: Actor,
  ): Promise<StallPlanView> {
    const { event, row } = await this.events.eventHallOf(access, id, hallId);
    this.assertCanEdit(access, event);
    const hall = await this.events.hall(access, id, hallId);
    const problems = [
      ...StallPlansService.structure(dto, hall),
      ...StallPlansService.rules(dto, hall),
    ];
    if (problems.length) throw new BadRequestException(StallPlansService.refusal(problems));

    return this.dataSource.transaction(async (em) => {
      const plans = em.getRepository(StallPlanEntity);
      // The row is made once, then locked, so two saves of one plan run one after the other.
      await plans
        .createQueryBuilder()
        .insert()
        .values({ eventHallId: row.id })
        .orIgnore()
        .execute();
      const plan = await plans.findOneOrFail({
        where: { eventHallId: row.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (plan.revision !== dto.revision) {
        throw new ConflictException(
          'Someone saved this plan after you opened it. Reload the planner to see their changes.',
        );
      }

      await em.getRepository(PlanObjectEntity).delete({ planId: plan.id });
      await em.getRepository(PlanSeatEntity).delete({ planId: plan.id });
      await em.getRepository(PlanStallEntity).delete({ planId: plan.id });
      await em.getRepository(PlanZoneEntity).delete({ planId: plan.id });
      await insertAll(
        em,
        PlanZoneEntity,
        dto.zones.map((z, i) => ({
          id: z.id,
          planId: plan.id,
          name: z.name,
          color: z.color.toLowerCase(),
          polygon: z.polygon,
          area: Math.round(ringArea(z.polygon) * 100) / 100,
          sortOrder: i,
        })),
      );
      await insertAll(
        em,
        PlanStallEntity,
        dto.stalls.map((s) => ({
          ...s,
          planId: plan.id,
          zoneId: s.zoneId ?? null,
          islandNumber: s.islandNumber ?? null,
          openSides: [...new Set(s.openSides)],
          categoryIds: [...new Set(s.categoryIds)],
          location: s.location ?? null,
          description: s.description ?? null,
        })),
      );
      await insertAll(
        em,
        PlanSeatEntity,
        dto.seats.map((s) => ({
          ...s,
          planId: plan.id,
          zoneId: s.zoneId ?? null,
          categoryId: s.categoryId ?? null,
        })),
      );
      await insertAll(
        em,
        PlanObjectEntity,
        dto.objects.map((o, i) => ({
          id: o.id,
          planId: plan.id,
          kind: o.kind,
          points: o.points,
          text: o.text ?? null,
          color: o.color.toLowerCase(),
          sortOrder: i,
        })),
      );

      plan.revision += 1;
      plan.updatedById = actor.id;
      const saved = await plans.save(plan);
      await this.audit.record(
        {
          action: 'plan.saved',
          actor,
          organisationId: access.organisation.id,
          targetType: 'event',
          targetId: event.id,
          metadata: {
            name: event.name,
            hall: hall.hall.name,
            revision: saved.revision,
            zones: dto.zones.length,
            stalls: dto.stalls.length,
            seats: dto.seats.length,
            objects: dto.objects.length,
          },
        },
        em,
      );
      return this.planView(em, saved);
    });
  }

  // ---- helpers ------------------------------------------------------------------------------

  /** Null when this member may draw on the event's halls; else why not, in words. */
  static readOnlyReason(access: OrgAccessContext, event: EventEntity): string | null {
    if (!access.permissions.includes('layouts.edit')) {
      return 'Your role can see stall plans but not draw them.';
    }
    const organiser = EventsService.isOrganiser(access);
    if (event.kind === 'external' && !organiser) {
      return `${event.organiserName ?? 'The organiser'} plans the stalls of this external event.`;
    }
    if (event.kind === 'internal' && organiser) {
      return 'The venue’s own team plans the stalls of internal events.';
    }
    return null;
  }

  private assertCanEdit(access: OrgAccessContext, event: EventEntity): void {
    const reason = StallPlansService.readOnlyReason(access, event);
    if (reason) throw new ForbiddenException(reason);
  }

  /** What makes the plan unsound before any rule: ids, numbers, zones, categories and drawings. */
  private static structure(plan: PlanContent, hall: EventHallDetailView): PlanFinding[] {
    const out: PlanFinding[] = [];
    const ids = new Set<string>();
    for (const item of [...plan.zones, ...plan.stalls, ...plan.seats, ...plan.objects]) {
      if (ids.has(item.id))
        out.push({ ruleId: 'plan', message: 'An id appears twice.', ids: [item.id] });
      ids.add(item.id);
    }
    const zones = new Set(plan.zones.map((z) => z.id));
    const sells = new Set(hall.categories.map((c) => c.id));
    const numbers = new Map<string, string>();
    for (const s of plan.stalls) {
      const number = stallNumber(s);
      const twin = numbers.get(number.toLowerCase());
      if (twin) {
        out.push({
          ruleId: 'plan',
          message: `Two stalls are numbered ${number}.`,
          ids: [twin, s.id],
        });
      } else {
        numbers.set(number.toLowerCase(), s.id);
      }
      if (s.zoneId && !zones.has(s.zoneId)) {
        out.push({
          ruleId: 'plan',
          message: `Stall ${number} is in a zone that is gone.`,
          ids: [s.id],
        });
      }
      if (s.categoryIds.some((c) => !sells.has(c))) {
        out.push({
          ruleId: 'plan',
          message: `Stall ${number} has a category this hall does not sell.`,
          ids: [s.id],
        });
      }
    }
    for (const s of plan.seats) {
      if (s.zoneId && !zones.has(s.zoneId)) {
        out.push({
          ruleId: 'plan',
          message: `Seat ${s.rowLabel}-${s.seatNumber} is in a zone that is gone.`,
          ids: [s.id],
        });
      }
      if (s.categoryId && !sells.has(s.categoryId)) {
        out.push({
          ruleId: 'plan',
          message: `Seat ${s.rowLabel}-${s.seatNumber} has a category this hall does not sell.`,
          ids: [s.id],
        });
      }
    }
    for (const z of plan.zones) {
      if (ringArea(z.polygon) < 0.01) {
        out.push({ ruleId: 'plan', message: `Zone ${z.name} has no area.`, ids: [z.id] });
      }
    }
    for (const o of plan.objects) {
      const problem = objectProblem(o);
      if (problem) out.push({ ruleId: 'plan', message: problem, ids: [o.id] });
    }
    return out;
  }

  /** The rules of the event hall, over the whole plan. */
  private static rules(plan: PlanContent, hall: EventHallDetailView): PlanFinding[] {
    return checkPlan({
      floor: hall.floor,
      switches: hall.rules.switches,
      values: hall.rules.values,
      eventType: hall.event.audience,
      profile: drawingProfile(hall.rules.drawingProfile),
      zones: plan.zones.map((z) => ({ id: z.id, name: z.name, polygon: z.polygon })),
      stalls: plan.stalls.map((s) => ({
        id: s.id,
        number: stallNumber(s),
        x: s.x,
        y: s.y,
        width: s.width,
        depth: s.depth,
        openSides: [...new Set(s.openSides)],
      })),
      seats: plan.seats.map((s) => ({
        id: s.id,
        label: `${s.rowLabel}-${s.seatNumber}`,
        x: s.x,
        y: s.y,
        width: s.width,
        depth: s.depth,
      })),
    });
  }

  private static published(plan: StallPlanEntity): StallPlanView['published'] {
    return plan.publishedRevision && plan.publishedAt
      ? { revision: plan.publishedRevision, at: plan.publishedAt.toISOString() }
      : null;
  }

  private static refusal(problems: PlanFinding[]): string {
    const named = problems.slice(0, NAMED).map((p) => p.message);
    const more = problems.length - named.length;
    return `The plan was not saved: ${named.join(' ')}${more ? ` And ${more} more.` : ''}`;
  }

  private async planView(em: EntityManager, plan: StallPlanEntity | null): Promise<StallPlanView> {
    if (!plan) {
      return {
        revision: 0,
        updatedAt: null,
        published: null,
        zones: [],
        stalls: [],
        seats: [],
        objects: [],
      };
    }
    // One after the other: inside a transaction they share one connection.
    const zones = await em
      .getRepository(PlanZoneEntity)
      .find({ where: { planId: plan.id }, order: { sortOrder: 'ASC' } });
    const stalls = await em.getRepository(PlanStallEntity).findBy({ planId: plan.id });
    const seats = await em.getRepository(PlanSeatEntity).find({
      where: { planId: plan.id },
      order: { rowLabel: 'ASC', seatNumber: 'ASC' },
    });
    const objects = await em
      .getRepository(PlanObjectEntity)
      .find({ where: { planId: plan.id }, order: { sortOrder: 'ASC' } });
    return {
      revision: plan.revision,
      updatedAt: plan.updatedAt.toISOString(),
      published: StallPlansService.published(plan),
      zones: zones.map(zoneView),
      stalls: stalls.map(stallView),
      seats: seats.map(seatView),
      objects: objects.map(objectView),
    };
  }
}

/** A stall's full number, as ITPO writes it: island and stall, e.g. "12A-27 E". */
function stallNumber(s: { islandNumber?: string | null; stallNumber: string }): string {
  return s.islandNumber ? `${s.islandNumber}${s.stallNumber}` : s.stallNumber;
}

/**
 * What is wrong with a drawing's shape, in words; null when nothing. The DTO has checked each
 * point; this checks how many there are for the kind, and that the shape has a size.
 */
function objectProblem(o: PlanObjectDto): string | null {
  const [a, b] = o.points;
  switch (o.kind) {
    case 'line':
      if (o.points.length !== 2) return 'A line is drawn with exactly 2 points.';
      return null;
    case 'rect':
      if (o.points.length !== 2) return 'A rectangle is drawn with 2 opposite corners.';
      if (a[0] === b[0] || a[1] === b[1]) return 'A rectangle has no area.';
      return null;
    case 'circle':
      if (o.points.length !== 2) {
        return 'A circle is drawn with its centre and a point on its edge.';
      }
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= 0) return 'A circle has no radius.';
      return null;
    case 'polyline':
      if (o.points.length < 2) return 'A polyline is drawn with 2 to 500 points.';
      return null;
    case 'text':
      if (o.points.length !== 1) return 'A text is placed with exactly 1 point.';
      if (!o.text) return 'A text drawing needs some text.';
      return null;
  }
}

async function insertAll<T extends object>(
  em: EntityManager,
  entity: new () => T,
  rows: Array<Partial<T>>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await em
      .createQueryBuilder()
      .insert()
      .into(entity)
      .values(rows.slice(i, i + CHUNK) as never)
      .execute();
  }
}

function zoneView(z: PlanZoneEntity): PlanZoneView {
  return { id: z.id, name: z.name, color: z.color, polygon: z.polygon, area: z.area };
}

function stallView(s: PlanStallEntity): PlanStallView {
  return {
    id: s.id,
    zoneId: s.zoneId,
    islandNumber: s.islandNumber,
    stallNumber: s.stallNumber,
    x: s.x,
    y: s.y,
    width: s.width,
    depth: s.depth,
    openSides: s.openSides,
    scheme: s.scheme,
    categoryIds: s.categoryIds,
    isPremium: s.isPremium,
    isBlocked: s.isBlocked,
    isFnb: s.isFnb,
    isBranding: s.isBranding,
    isHorseshoe: s.isHorseshoe,
    isMarqueeAvailable: s.isMarqueeAvailable,
    isRestrictedForOverseas: s.isRestrictedForOverseas,
    isActive: s.isActive,
    location: s.location,
    description: s.description,
  };
}

function seatView(s: PlanSeatEntity): PlanSeatView {
  return {
    id: s.id,
    zoneId: s.zoneId,
    rowLabel: s.rowLabel,
    seatNumber: s.seatNumber,
    x: s.x,
    y: s.y,
    width: s.width,
    depth: s.depth,
    categoryId: s.categoryId,
  };
}

function objectView(o: PlanObjectEntity): PlanObjectView {
  return { id: o.id, kind: o.kind, points: o.points, text: o.text, color: o.color };
}
