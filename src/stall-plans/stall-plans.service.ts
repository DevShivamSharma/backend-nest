import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor, AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { EventEntity } from '../events/event.entity';
import type { EventHallDetailView } from '../events/event.views';
import { EventsService } from '../events/events.service';
import { MailMessage, MailService } from '../mail/mail.service';
import { drawingProfile } from '../rules/drawing-profiles';
import { ringArea } from '../venues/floor-plan/geometry';
import {
  CheckPlanDto,
  PlanObjectDto,
  PlanSeatDto,
  PlanStallDto,
  PlanZoneDto,
  PublishPlanDto,
  RejectPlanDto,
  SavePlanDto,
} from './dto/stall-plans.dto';
import { checkPlan, findingsFor, PlanFinding } from './plan-check';
import { PricingService } from './pricing/pricing.service';
import {
  planApprovedEmail,
  planRejectedEmail,
  planSubmittedEmail,
  PlanReviewMail,
} from './plan-review-email';
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
  PlanReviewView,
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
 *
 * Who publishes: on an internal event the venue's team (`layouts.publish`). On an external one
 * the organiser (`layouts.publish`) sends the saved plan for approval, and the venue's team
 * (`layouts.approve`) approves it, which publishes it, or sends it back with a note. Each step
 * is emailed to the other side. While a plan waits, the organiser cannot change it, only
 * withdraw it.
 */
@Injectable()
export class StallPlansService {
  private readonly logger = new Logger(StallPlansService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly pricing: PricingService,
  ) {}

  async get(access: OrgAccessContext, id: string, hallId: string): Promise<PlannerView> {
    const hall = await this.events.hall(access, id, hallId);
    const { event, row } = await this.events.eventHallOf(access, id, hallId);
    const plan = await this.dataSource
      .getRepository(StallPlanEntity)
      .findOneBy({ eventHallId: row.id });
    const drawer = StallPlansService.readOnlyReason(access, event);
    const waiting = event.kind === 'external' && plan?.reviewStatus === 'submitted';
    const readOnlyReason = drawer ?? (waiting ? StallPlansService.waitingReason(access) : null);
    const publisher = !drawer && access.permissions.includes('layouts.publish');
    const venueTeam = !EventsService.isOrganiser(access);
    const saved = await this.planView(this.dataSource.manager, plan);
    // The venue reviews an external event's plan: what the saved plan breaks, if anything.
    const findings =
      event.kind === 'external' && venueTeam && saved.revision > 0
        ? [...StallPlansService.structure(saved, hall), ...StallPlansService.rules(saved, hall)]
        : null;
    return {
      hall,
      plan: saved,
      findings,
      pricing: await this.pricing.view(access, event, row.id),
      canEdit: !readOnlyReason,
      readOnlyReason,
      canPublish: publisher && event.kind === 'internal',
      needsApproval: event.kind === 'external',
      canSubmit: publisher && event.kind === 'external' && !waiting,
      canWithdraw: !drawer && waiting,
      canApprove: waiting && venueTeam && access.permissions.includes('layouts.approve'),
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
    if (event.kind === 'external') {
      throw new ForbiddenException(
        `${access.organisation.name} publishes the plans of external events: send it for approval.`,
      );
    }
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
      if (event.kind === 'external' && plan.reviewStatus === 'submitted') {
        throw new ForbiddenException(StallPlansService.waitingReason(access));
      }
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

      await this.pricing.dropMissing(
        em,
        row.id,
        dto.stalls.map((st) => st.id),
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

  // ---- approval of external events' plans ---------------------------------------------------

  /** The organiser sends the saved plan to the venue for approval; the venue is emailed. */
  async submit(
    access: OrgAccessContext,
    id: string,
    hallId: string,
    dto: PublishPlanDto,
    actor: AuthUser,
  ): Promise<StallPlanView> {
    const { event, row } = await this.events.eventHallOf(access, id, hallId);
    this.assertCanEdit(access, event);
    if (event.kind !== 'external') {
      throw new BadRequestException(
        'Plans of internal events are published, not sent for approval.',
      );
    }
    const hall = await this.events.hall(access, id, hallId);
    const view = await this.dataSource.transaction(async (em) => {
      const plans = em.getRepository(StallPlanEntity);
      const plan = await plans.findOne({
        where: { eventHallId: row.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!plan || plan.revision === 0) {
        throw new BadRequestException('Save the plan before sending it for approval.');
      }
      if (plan.reviewStatus === 'submitted') {
        throw new ConflictException('This plan is already waiting for approval.');
      }
      if (plan.revision !== dto.revision) {
        throw new ConflictException(
          'The saved plan changed after you opened it. Reload the planner, then send it.',
        );
      }
      if (plan.publishedRevision === plan.revision) {
        throw new BadRequestException('This plan is approved and published as it is.');
      }
      const saved = await this.planView(em, plan);
      const problems = [
        ...StallPlansService.structure(saved, hall),
        ...StallPlansService.rules(saved, hall),
      ];
      if (problems.length) {
        throw new BadRequestException(
          StallPlansService.refusal(problems).replace('was not saved', 'was not sent'),
        );
      }
      // Prices are not the venue's to approve, but a plan goes with every stall for sale priced.
      const unpriced = await this.pricing.unpriced(em, plan);
      if (unpriced.length) {
        throw new BadRequestException(
          `The plan was not sent: ${PricingService.unpricedMessage(unpriced)}`,
        );
      }
      Object.assign(plan, {
        reviewStatus: 'submitted',
        reviewRevision: plan.revision,
        submittedAt: new Date(),
        submittedById: actor.id,
        reviewedAt: null,
        reviewedById: null,
        reviewNote: null,
      });
      const sent = await plans.save(plan);
      await this.audit.record(
        {
          action: 'plan.submitted',
          actor,
          organisationId: access.organisation.id,
          targetType: 'event',
          targetId: event.id,
          metadata: { name: event.name, hall: hall.hall.name, revision: plan.revision },
        },
        em,
      );
      return this.planView(em, sent);
    });
    const to = await this.approverEmails(access.organisation.id);
    await this.notify(
      planSubmittedEmail(
        this.reviewMail(access, event, hall, view.revision, actor, id, hallId, to),
      ),
    );
    return view;
  }

  /** The organiser takes back a plan that waits for approval, to change it. */
  async withdraw(
    access: OrgAccessContext,
    id: string,
    hallId: string,
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
      if (!plan || plan.reviewStatus !== 'submitted') {
        throw new ConflictException('This plan is not waiting for approval.');
      }
      const revision = plan.reviewRevision;
      Object.assign(plan, StallPlansService.noReview());
      const back = await plans.save(plan);
      await this.audit.record(
        {
          action: 'plan.withdrawn',
          actor,
          organisationId: access.organisation.id,
          targetType: 'event',
          targetId: event.id,
          metadata: { name: event.name, hall: hall.hall.name, revision },
        },
        em,
      );
      return this.planView(em, back);
    });
  }

  /**
   * The venue approves the plan that waits, which publishes it, or sends it back with a note.
   * Either way the organiser is emailed. Approval checks the rules again: they may have
   * changed since the plan was sent.
   */
  async review(
    access: OrgAccessContext,
    id: string,
    hallId: string,
    dto: PublishPlanDto | RejectPlanDto,
    approve: boolean,
    actor: AuthUser,
  ): Promise<StallPlanView> {
    const { event, row } = await this.events.eventHallOf(access, id, hallId);
    if (event.kind !== 'external' || EventsService.isOrganiser(access)) {
      throw new ForbiddenException(
        `${access.organisation.name}’s team approves the plans of external events.`,
      );
    }
    const hall = await this.events.hall(access, id, hallId);
    const note = 'note' in dto ? dto.note : null;
    const { view, submittedById } = await this.dataSource.transaction(async (em) => {
      const plans = em.getRepository(StallPlanEntity);
      const plan = await plans.findOne({
        where: { eventHallId: row.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!plan || plan.reviewStatus !== 'submitted') {
        throw new ConflictException('This plan is not waiting for approval.');
      }
      if (plan.reviewRevision !== dto.revision) {
        throw new ConflictException(
          'The organiser changed what waits for approval. Reload the planner to see it.',
        );
      }
      const now = new Date();
      if (approve) {
        const saved = await this.planView(em, plan);
        const problems = [
          ...StallPlansService.structure(saved, hall),
          ...StallPlansService.rules(saved, hall),
        ];
        if (problems.length) {
          throw new BadRequestException(
            StallPlansService.refusal(problems).replace(
              'The plan was not saved',
              'The plan cannot be approved; send it back',
            ),
          );
        }
        Object.assign(plan, {
          publishedRevision: plan.revision,
          publishedAt: now,
          publishedById: actor.id,
        });
      }
      Object.assign(plan, {
        reviewStatus: approve ? 'approved' : 'rejected',
        reviewedAt: now,
        reviewedById: actor.id,
        reviewNote: note,
      });
      const answered = await plans.save(plan);
      await this.audit.record(
        {
          action: approve ? 'plan.approved' : 'plan.rejected',
          actor,
          organisationId: access.organisation.id,
          targetType: 'event',
          targetId: event.id,
          metadata: {
            name: event.name,
            hall: hall.hall.name,
            revision: plan.revision,
            ...(note ? { note } : {}),
          },
        },
        em,
      );
      return { view: await this.planView(em, answered), submittedById: plan.submittedById };
    });
    const to = await this.organiserEmails(access.organisation.id, event.id, submittedById);
    const mail = this.reviewMail(access, event, hall, dto.revision, actor, id, hallId, to);
    await this.notify(
      approve ? planApprovedEmail(mail) : planRejectedEmail({ ...mail, note: note! }),
    );
    return view;
  }

  /** Members of the venue's own team who may approve: their role holds `layouts.approve`. */
  private async approverEmails(organisationId: string): Promise<string[]> {
    const rows: Array<{ email: string }> = await this.dataSource.query(
      `SELECT DISTINCT u.email
         FROM memberships m
         JOIN roles r ON r.id = m.role_id
         JOIN users u ON u.id = m.user_id
        WHERE m.organisation_id = $1
          AND u.status = 'active'
          AND r.scope_kind = 'organisation'
          AND (r.is_locked OR 'layouts.approve' = ANY (r.permissions))`,
      [organisationId],
    );
    return rows.map((r) => r.email);
  }

  /** Who sent the plan, and the event's organisers who may draw it. */
  private async organiserEmails(
    organisationId: string,
    eventId: string,
    submittedById: string | null,
  ): Promise<string[]> {
    const rows: Array<{ email: string }> = await this.dataSource.query(
      `SELECT DISTINCT u.email
         FROM memberships m
         JOIN roles r ON r.id = m.role_id
         JOIN users u ON u.id = m.user_id
        WHERE m.organisation_id = $1
          AND u.status = 'active'
          AND (
            u.id = $3
            OR (
              r.scope_kind = 'event'
              AND m.scope -> 'eventIds' @> jsonb_build_array($2::text)
              AND 'layouts.edit' = ANY (r.permissions)
            )
          )`,
      [organisationId, eventId, submittedById],
    );
    return rows.map((r) => r.email);
  }

  private reviewMail(
    access: OrgAccessContext,
    event: EventEntity,
    hall: EventHallDetailView,
    revision: number,
    actor: AuthUser,
    id: string,
    hallId: string,
    to: string[],
  ): PlanReviewMail {
    return {
      to,
      organisation: access.organisation,
      eventName: event.name,
      organiserName: event.organiserName,
      hallName: hall.hall.name,
      revision,
      byName: actor.name,
      link: this.mail.link(`/${access.organisation.slug}/events/${id}/halls/${hallId}/planner`),
    };
  }

  /** Sends after the change is stored: a mail server that fails does not undo the approval. */
  private async notify(message: MailMessage): Promise<void> {
    try {
      await this.mail.send(message);
    } catch (error) {
      this.logger.error(
        `Could not send "${message.subject}": ${error instanceof Error ? error.message : error}`,
      );
    }
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

  /** Why the organiser cannot change a plan that waits for approval. */
  private static waitingReason(access: OrgAccessContext): string {
    return `The plan was sent to ${access.organisation.name} for approval. It can change again once they answer, or after you withdraw it.`;
  }

  private static noReview(): Partial<StallPlanEntity> {
    return {
      reviewStatus: null,
      reviewRevision: null,
      submittedAt: null,
      submittedById: null,
      reviewedAt: null,
      reviewedById: null,
      reviewNote: null,
    };
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

  private async reviewView(
    em: EntityManager,
    plan: StallPlanEntity,
  ): Promise<PlanReviewView | null> {
    if (!plan.reviewStatus || !plan.reviewRevision || !plan.submittedAt) return null;
    const ids = [plan.submittedById, plan.reviewedById].filter((v): v is string => !!v);
    const names = new Map<string, string>(
      ids.length
        ? (await em.query(`SELECT id, name FROM users WHERE id = ANY ($1::uuid[])`, [ids])).map(
            (u: { id: string; name: string }) => [u.id, u.name],
          )
        : [],
    );
    return {
      status: plan.reviewStatus,
      revision: plan.reviewRevision,
      submittedAt: plan.submittedAt.toISOString(),
      submittedBy: (plan.submittedById && names.get(plan.submittedById)) ?? null,
      reviewedAt: plan.reviewedAt?.toISOString() ?? null,
      reviewedBy: (plan.reviewedById && names.get(plan.reviewedById)) ?? null,
      note: plan.reviewNote,
    };
  }

  private async planView(em: EntityManager, plan: StallPlanEntity | null): Promise<StallPlanView> {
    if (!plan) {
      return {
        revision: 0,
        updatedAt: null,
        published: null,
        review: null,
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
      review: await this.reviewView(em, plan),
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
