import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor, OrgAccessContext } from '../common/http/authenticated-request';
import { EventEntity } from '../events/event.entity';
import { EventsService } from '../events/events.service';
import type { Permission } from '../roles/permissions';
import type { RuleOverride, RuleReport } from '../rules/rule-engine';
import { RulesService } from '../rules/rules.service';
import { HallsService } from '../venues/halls.service';
import { SavePlanDto } from './dto/stall-plan.dto';
import { StallEntity, StallPlanEntity, StallPlanStatus } from './stall-plan.entity';
import type { EventPlanSummaryView, StallPlanView, StallView } from './stall-plan.views';

/** Who may see a plan before it is published: those who draw, approve or publish plans. */
const DRAFT_READERS: readonly Permission[] = ['layouts.edit', 'layouts.approve', 'layouts.publish'];

/**
 * Stall plans (the catalogue's "stall layouts"): the stalls of one hall of one event, on the
 * floor version the event booked. A plan is drawn as a draft, approved once it passes the rules
 * (or sets rules aside with reasons), and published to booking. Only published stalls can be
 * held or booked; a plan with active bookings cannot be reopened.
 */
@Injectable()
export class StallPlansService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly halls: HallsService,
    private readonly rules: RulesService,
    private readonly audit: AuditService,
  ) {}

  /** Every hall of the event with its plan, as far as the member may see plans. */
  async summaries(access: OrgAccessContext, eventId: string): Promise<EventPlanSummaryView[]> {
    const em = this.dataSource.manager;
    await this.events.getEvent(em, access, eventId);
    const drafts = StallPlansService.readsDrafts(access);
    const rows: {
      hall_id: string;
      hall_name: string;
      plan_id: string | null;
      status: StallPlanStatus | null;
      revision: number | null;
      stall_count: number;
      active_bookings: number;
    }[] = await em.query(
      `SELECT eh.hall_id, h.name AS hall_name, sp.id AS plan_id, sp.status, sp.revision,
              (SELECT count(*)::int FROM stalls s WHERE s.plan_id = sp.id) AS stall_count,
              (SELECT count(*)::int FROM bookings b JOIN stalls s ON s.id = b.stall_id
                WHERE s.plan_id = sp.id AND b.status IN ('held', 'confirmed')) AS active_bookings
         FROM event_halls eh
         JOIN halls h ON h.id = eh.hall_id
         LEFT JOIN stall_plans sp ON sp.event_id = eh.event_id AND sp.hall_id = eh.hall_id
        WHERE eh.event_id = $1
        ORDER BY h.name`,
      [eventId],
    );
    return rows.map((r) => {
      const visible = r.plan_id !== null && (drafts || r.status === 'published');
      return {
        hallId: r.hall_id,
        hallName: r.hall_name,
        planId: visible ? r.plan_id : null,
        status: visible ? r.status : null,
        revision: visible ? (r.revision ?? 0) : 0,
        stallCount: visible ? r.stall_count : 0,
        activeBookings: visible ? r.active_bookings : 0,
      };
    });
  }

  async get(access: OrgAccessContext, eventId: string, hallId: string): Promise<StallPlanView> {
    const em = this.dataSource.manager;
    const event = await this.events.getEvent(em, access, eventId);
    const plan = await em.getRepository(StallPlanEntity).findOneBy({ eventId, hallId });
    if (!StallPlansService.readsDrafts(access) && plan?.status !== 'published') {
      throw new NotFoundException('No stall plan has been published for this hall yet.');
    }
    return this.view(em, access, event, hallId, plan);
  }

  /**
   * Saves the draft as the editor holds it: stalls with an id are updated, new ones added,
   * missing ones removed (never one with bookings). The first save creates the plan.
   */
  async save(
    access: OrgAccessContext,
    eventId: string,
    hallId: string,
    dto: SavePlanDto,
    actor: Actor,
  ): Promise<StallPlanView> {
    StallPlansService.assertUnique(dto);
    await this.dataSource.transaction(async (em) => {
      const event = await this.events.getEvent(em, access, eventId, true);
      EventsService.assertOpen(event);
      const { hall } = await this.events.getEventHall(em, event, hallId);
      const plans = em.getRepository(StallPlanEntity);
      let plan = await plans.findOne({
        where: { eventId, hallId },
        lock: { mode: 'pessimistic_write' },
      });
      if ((plan?.revision ?? 0) !== dto.revision) {
        throw new ConflictException('The plan changed since you opened it. Reload it first.');
      }
      if (plan && plan.status !== 'draft') {
        const article = plan.status === 'approved' ? 'An' : 'A';
        throw new ConflictException(
          `${article} ${plan.status} plan cannot change. Reopen it first.`,
        );
      }
      plan ??= await plans.save(
        plans.create({
          organisationId: access.organisation.id,
          eventId,
          hallId,
          status: 'draft',
          revision: 0,
          ruleOverrides: [],
        }),
      );

      const repo = em.getRepository(StallEntity);
      const existing = await repo.findBy({ planId: plan.id });
      const byId = new Map(existing.map((s) => [s.id, s]));
      for (const s of dto.stalls) {
        if (s.id && !byId.has(s.id)) {
          throw new BadRequestException(`Stall ${s.number} is not part of this plan.`);
        }
      }
      const kept = new Set(dto.stalls.flatMap((s) => (s.id ? [s.id] : [])));
      const removed = existing.filter((s) => !kept.has(s.id));
      if (removed.length) {
        const booked: { number: string }[] = await em.query(
          `SELECT DISTINCT s.number FROM bookings b JOIN stalls s ON s.id = b.stall_id
            WHERE b.stall_id = ANY($1::uuid[])`,
          [removed.map((s) => s.id)],
        );
        if (booked.length) {
          throw new ConflictException(
            `Stall ${booked.map((b) => b.number).join(', ')} has bookings and stays in the plan.`,
          );
        }
        await repo.delete(removed.map((s) => s.id));
      }
      // Numbers are unique per plan: park renumbered stalls first, so two can swap numbers.
      const renumbered = dto.stalls.filter((s) => s.id && byId.get(s.id)!.number !== s.number);
      for (const s of renumbered) await repo.update({ id: s.id }, { number: `~${s.id}` });

      const ids: string[] = [];
      for (const s of dto.stalls) {
        const values = {
          number: s.number,
          x: s.x,
          y: s.y,
          width: s.width,
          depth: s.depth,
          openSides: [...new Set(s.openSides)],
          stallType: s.stallType ?? null,
        };
        if (s.id) {
          await repo.update({ id: s.id }, values);
          ids.push(s.id);
        } else {
          ids.push((await repo.save(repo.create({ planId: plan.id, ...values }))).id);
        }
      }

      if (dto.overrides) {
        const known = new Set(ids);
        for (const o of dto.overrides) {
          if (o.stallIds?.some((id) => !known.has(id))) {
            throw new BadRequestException(
              'An override names a stall that is not in the plan. Save the stall first.',
            );
          }
        }
        plan.ruleOverrides = dto.overrides.map((o): RuleOverride => ({
          ruleId: o.ruleId,
          stallIds: o.stallIds ?? null,
          reason: o.reason,
          by: actor.email,
        }));
      }
      plan.revision += 1;
      await plans.save(plan);
      await this.audit.record(
        {
          action: 'stall_plan.saved',
          actor,
          organisationId: access.organisation.id,
          targetType: 'stall_plan',
          targetId: plan.id,
          metadata: {
            event: event.name,
            hall: hall.name,
            stalls: dto.stalls.length,
            revision: plan.revision,
          },
        },
        em,
      );
    });
    return this.get(access, eventId, hallId);
  }

  /** Approves a draft that passes the rules, every remaining violation set aside with a reason. */
  async approve(
    access: OrgAccessContext,
    eventId: string,
    hallId: string,
    revision: number,
    actor: Actor,
  ): Promise<StallPlanView> {
    await this.transition(access, eventId, hallId, revision, actor, async (em, event, plan) => {
      if (plan.status !== 'draft') throw new ConflictException('Only a draft plan is approved.');
      const stalls = await em.getRepository(StallEntity).findBy({ planId: plan.id });
      if (!stalls.length) throw new ConflictException('Draw at least one stall first.');
      const report = await this.report(access, event, hallId, plan, stalls);
      const blocking = report.violations.filter((v) => !v.overridden).length;
      if (!report.passed) {
        throw new ConflictException(
          `The plan breaks ${blocking} rule check(s). Fix them, or set them aside with a reason, before approving.`,
        );
      }
      plan.status = 'approved';
      plan.approvedById = actor.id;
      plan.approvedAt = new Date();
      return 'stall_plan.approved';
    });
    return this.get(access, eventId, hallId);
  }

  /** Sends an approved plan to booking. */
  async publish(
    access: OrgAccessContext,
    eventId: string,
    hallId: string,
    revision: number,
    actor: Actor,
  ): Promise<StallPlanView> {
    await this.transition(access, eventId, hallId, revision, actor, async (_em, _event, plan) => {
      if (plan.status !== 'approved') {
        throw new ConflictException('Approve the plan before publishing it.');
      }
      plan.status = 'published';
      plan.publishedById = actor.id;
      plan.publishedAt = new Date();
      return 'stall_plan.published';
    });
    return this.get(access, eventId, hallId);
  }

  /** Back to a draft, for changes; not while any of its stalls is held or booked. */
  async reopen(
    access: OrgAccessContext,
    eventId: string,
    hallId: string,
    revision: number,
    actor: Actor,
  ): Promise<StallPlanView> {
    await this.transition(access, eventId, hallId, revision, actor, async (em, _event, plan) => {
      if (plan.status === 'draft') throw new ConflictException('The plan is already a draft.');
      const active = await this.activeBookings(em, plan.id);
      if (active) {
        throw new ConflictException(
          `${active} stall(s) of this plan are held or booked. Cancel those bookings first.`,
        );
      }
      plan.status = 'draft';
      plan.approvedById = null;
      plan.approvedAt = null;
      plan.publishedById = null;
      plan.publishedAt = null;
      return 'stall_plan.reopened';
    });
    return this.get(access, eventId, hallId);
  }

  /** Deletes a draft plan whose stalls were never booked, so the hall can leave the event. */
  async remove(
    access: OrgAccessContext,
    eventId: string,
    hallId: string,
    actor: Actor,
  ): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const event = await this.events.getEvent(em, access, eventId, true);
      EventsService.assertOpen(event);
      const plan = await this.lockPlan(em, eventId, hallId);
      if (plan.status !== 'draft') {
        throw new ConflictException('Reopen the plan before deleting it.');
      }
      const [{ count }] = await em.query(
        `SELECT count(*)::int AS count FROM bookings b JOIN stalls s ON s.id = b.stall_id
          WHERE s.plan_id = $1`,
        [plan.id],
      );
      if (count) throw new ConflictException('The plan has booking history and stays.');
      await em.getRepository(StallPlanEntity).delete({ id: plan.id });
      await this.audit.record(
        {
          action: 'stall_plan.deleted',
          actor,
          organisationId: access.organisation.id,
          targetType: 'stall_plan',
          targetId: plan.id,
          metadata: { event: event.name, hallId },
        },
        em,
      );
    });
  }

  // --- building blocks, also used by bookings ----------------------------------------------

  /** A stall of a published plan of the event, with its plan; 404 / 409 otherwise. */
  async publishedStall(
    em: EntityManager,
    eventId: string,
    stallId: string,
  ): Promise<{ stall: StallEntity; plan: StallPlanEntity }> {
    const stall = await em
      .getRepository(StallEntity)
      .createQueryBuilder('stall')
      .innerJoinAndSelect('stall.plan', 'plan')
      .where('stall.id = :stallId', { stallId })
      .andWhere('plan.eventId = :eventId', { eventId })
      .getOne();
    if (!stall?.plan) throw new NotFoundException('There is no such stall at this event.');
    if (stall.plan.status !== 'published') {
      throw new ConflictException(`Stall ${stall.number} is not open for booking yet.`);
    }
    return { stall, plan: stall.plan };
  }

  static stallView(stall: StallEntity): StallView {
    return {
      id: stall.id,
      number: stall.number,
      x: stall.x,
      y: stall.y,
      width: stall.width,
      depth: stall.depth,
      area: Math.round(stall.width * stall.depth * 100) / 100,
      openSides: stall.openSides,
      stallType: stall.stallType,
    };
  }

  static readsDrafts(access: OrgAccessContext): boolean {
    return DRAFT_READERS.some((p) => access.permissions.includes(p));
  }

  // --- helpers ----------------------------------------------------------------------------

  private async view(
    em: EntityManager,
    access: OrgAccessContext,
    event: EventEntity,
    hallId: string,
    plan: StallPlanEntity | null,
  ): Promise<StallPlanView> {
    const { link, hall } = await this.events.getEventHall(em, event, hallId);
    const stalls = plan
      ? await em.getRepository(StallEntity).find({
          where: { planId: plan.id },
          order: { number: 'ASC' },
        })
      : [];
    const { floor } = await this.halls.floorVersion(
      access.organisation.id,
      hallId,
      link.floorVersion,
    );
    const report = await this.rules.checkOnFloor(access.organisation.id, {
      floor,
      stalls: stalls.map(StallPlansService.planStall),
      eventType: event.eventType,
      overrides: plan?.ruleOverrides ?? [],
    });
    return {
      id: plan?.id ?? null,
      event: { id: event.id, name: event.name, status: event.status, eventType: event.eventType },
      hall: {
        id: hall.id,
        name: hall.name,
        floorVersion: link.floorVersion,
        currentVersion: hall.currentVersion,
      },
      status: plan?.status ?? 'draft',
      revision: plan?.revision ?? 0,
      stalls: stalls.map(StallPlansService.stallView),
      overrides: plan?.ruleOverrides ?? [],
      approvedAt: plan?.approvedAt?.toISOString() ?? null,
      publishedAt: plan?.publishedAt?.toISOString() ?? null,
      activeBookings: plan ? await this.activeBookings(em, plan.id) : 0,
      floor,
      report,
    };
  }

  private async report(
    access: OrgAccessContext,
    event: EventEntity,
    hallId: string,
    plan: StallPlanEntity,
    stalls: StallEntity[],
  ): Promise<RuleReport> {
    const link = await this.events.getEventHall(this.dataSource.manager, event, hallId);
    const { floor } = await this.halls.floorVersion(
      access.organisation.id,
      hallId,
      link.link.floorVersion,
    );
    return this.rules.checkOnFloor(access.organisation.id, {
      floor,
      stalls: stalls.map(StallPlansService.planStall),
      eventType: event.eventType,
      overrides: plan.ruleOverrides,
    });
  }

  /** Runs one status change on the locked plan at the expected revision, and records it. */
  private async transition(
    access: OrgAccessContext,
    eventId: string,
    hallId: string,
    revision: number,
    actor: Actor,
    change: (em: EntityManager, event: EventEntity, plan: StallPlanEntity) => Promise<string>,
  ): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const event = await this.events.getEvent(em, access, eventId, true);
      EventsService.assertOpen(event);
      const plan = await this.lockPlan(em, eventId, hallId);
      if (plan.revision !== revision) {
        throw new ConflictException('The plan changed since you opened it. Reload it first.');
      }
      const from = plan.status;
      const action = await change(em, event, plan);
      plan.revision += 1;
      await em.getRepository(StallPlanEntity).save(plan);
      await this.audit.record(
        {
          action,
          actor,
          organisationId: access.organisation.id,
          targetType: 'stall_plan',
          targetId: plan.id,
          metadata: { event: event.name, hallId, from, to: plan.status, revision: plan.revision },
        },
        em,
      );
    });
  }

  private async lockPlan(
    em: EntityManager,
    eventId: string,
    hallId: string,
  ): Promise<StallPlanEntity> {
    const plan = await em.getRepository(StallPlanEntity).findOne({
      where: { eventId, hallId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!plan) throw new NotFoundException('This hall has no stall plan yet.');
    return plan;
  }

  private async activeBookings(em: EntityManager, planId: string): Promise<number> {
    const [{ count }] = await em.query(
      `SELECT count(*)::int AS count FROM bookings b JOIN stalls s ON s.id = b.stall_id
        WHERE s.plan_id = $1 AND b.status IN ('held', 'confirmed')`,
      [planId],
    );
    return count;
  }

  private static planStall(stall: StallEntity) {
    return {
      id: stall.id,
      number: stall.number,
      x: stall.x,
      y: stall.y,
      width: stall.width,
      depth: stall.depth,
      openSides: stall.openSides,
    };
  }

  private static assertUnique(dto: SavePlanDto): void {
    const numbers = new Set<string>();
    const ids = new Set<string>();
    for (const s of dto.stalls) {
      if (numbers.has(s.number)) {
        throw new BadRequestException(`Stall number ${s.number} appears twice.`);
      }
      numbers.add(s.number);
      if (s.id) {
        if (ids.has(s.id)) throw new BadRequestException(`Stall ${s.number} appears twice.`);
        ids.add(s.id);
      }
    }
  }
}
