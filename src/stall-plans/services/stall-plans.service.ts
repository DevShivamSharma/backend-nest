import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { PlanNotificationsService } from './plan-notifications.service';
import { AuditService } from '../../audit/audit.service';
import type { SessionUser } from '../../auth/domain/session-user';
import { UserType } from '../../auth/domain/user-type';
import type {
  CheckPlanDto,
  PublishPlanDto,
  RejectPlanDto,
  SavePlanDto,
} from '../dto/stall-plans.dto';
import type { HallFloor } from '../domain/hall-floor';
import { ringArea } from '../domain/geometry';
import { itpoStall, ItpoStall } from '../domain/itpo-stall-push';
import { findingsFor, PlanFinding } from '../domain/plan-check';
import { planAccess, PlanAccess, PlanReviewStatus } from '../domain/plan-access';
import {
  planRules,
  planStructure,
  refusal,
  PlanDraft,
  PlanRulesContext,
} from '../domain/plan-structure';
import type { PlanContent } from '../domain/plan.model';
import { stallFromItpo, type ItpoStallRow } from '../domain/itpo-stall-import';
import type { ProofFile } from '../domain/proof-files';
import { publishedStallRows, stallLabel } from '../domain/published-stalls';
import { cleanCutCells } from '../domain/stall-cells';
import { PlanCategory, PlanContextService, PlanEventHall } from './plan-context.service';

interface PlanRow {
  event_hall_id: string;
  revision: number;
  content: PlanContent;
  review_status: PlanReviewStatus | null;
  review_revision: number | null;
  submitted_at: Date | null;
  submitted_by: string | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  review_note: string | null;
  published_revision: number | null;
  published_at: Date | null;
  updated_at: Date;
}

export interface AttachmentView {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface PlanReviewView {
  status: PlanReviewStatus;
  revision: number;
  submittedAt: string;
  reviewedAt: string | null;
  /** Why ITPO sent it back. */
  note: string | null;
  /** The proof ITPO attached when sending it back. */
  attachments: AttachmentView[];
}

export interface StallPlanView extends PlanContent {
  /** 0 before the first save. */
  revision: number;
  updatedAt: string | null;
  /** The published revision; it may be older than the saved one. */
  published: { revision: number; at: string } | null;
  /** ITPO's approval of an external event's plan; null while it was never sent. */
  review: PlanReviewView | null;
  /** True when the stalls are ITPO's own for this hall, shown because nothing was saved here yet. */
  imported: boolean;
}

/** Everything the planner opens with: the hall as the event has it, its plan, and what this user may do. */
export interface PlannerView extends PlanAccess {
  event: {
    id: string;
    name: string;
    kind: 'internal' | 'external';
    approvalStatus: string | null;
    audience: 'B2B' | 'B2C';
    organiserName: string | null;
  };
  hall: { id: string; hallId: number; name: string; code: string | null };
  floor: HallFloor;
  rules: Pick<PlanRulesContext, 'switches' | 'values' | 'drawingProfile'>;
  /** The categories this hall sells; the planner offers only these. */
  categories: PlanCategory[];
  plan: StallPlanView;
  /** For ITPO staff reviewing an external event's plan: what the saved plan breaks now. */
  findings: PlanFinding[] | null;
}

const EMPTY: PlanContent = { zones: [], stalls: [], seats: [], objects: [] };

/**
 * The stall plan of an event hall: zones, stalls and seats on the floor the event keeps, checked
 * against the rules of that event. A change that breaks a rule is refused. The plan is a draft in
 * our own table; publishing writes its stalls to ITPO's `T_STALLS`.
 */
@Injectable()
export class StallPlansService {
  private readonly logger = new Logger(StallPlansService.name);

  constructor(
    private readonly db: DataSource,
    private readonly context: PlanContextService,
    private readonly audit: AuditService,
    private readonly notify: PlanNotificationsService,
  ) {}

  async get(eventId: string, eventHallId: string, user: SessionUser): Promise<PlannerView> {
    const hall = await this.context.eventHall(eventId, eventHallId, user);
    const [rules, categories, row] = await Promise.all([
      this.context.rulesOf(hall),
      this.context.categories(hall),
      this.row(this.db.manager, eventHallId),
    ]);
    const plan = await this.withExistingStalls(
      planView(
        row,
        row?.review_status === 'rejected'
          ? await this.attachments(this.db.manager, eventHallId)
          : [],
      ),
      hall,
    );
    const access = this.access(hall, user, row);
    const review = !access.canEdit && hall.kind === 'external' && !isOrganiser(user);
    const findings = review && plan.revision > 0 ? this.problems(plan, rules, categories) : null;
    return {
      ...access,
      event: {
        id: hall.eventId,
        name: hall.eventName,
        kind: hall.kind,
        approvalStatus: hall.approvalStatus,
        audience: hall.audience,
        organiserName: hall.organiserName,
      },
      hall: { id: hall.eventHallId, hallId: hall.hallId, name: hall.hallName, code: hall.hallCode },
      floor: rules.floor,
      rules: {
        switches: rules.switches,
        values: rules.values,
        drawingProfile: rules.drawingProfile,
      },
      categories,
      plan,
      findings,
    };
  }

  /** The hall whose plan this user may change (for reading a drawing of it); refuses otherwise. */
  async editableHall(
    eventId: string,
    eventHallId: string,
    user: SessionUser,
  ): Promise<{ name: string; code: string | null }> {
    const hall = await this.context.eventHall(eventId, eventHallId, user);
    this.assertCanEdit(hall, user, await this.row(this.db.manager, eventHallId));
    return { name: hall.hallName, code: hall.hallCode };
  }

  /** The rules the planner's change breaks: those about `changed`, or about the whole plan. */
  async check(
    eventId: string,
    eventHallId: string,
    dto: CheckPlanDto,
    user: SessionUser,
  ): Promise<{ findings: PlanFinding[] }> {
    const hall = await this.context.eventHall(eventId, eventHallId, user);
    this.assertCanEdit(hall, user, await this.row(this.db.manager, eventHallId));
    const [rules, categories] = await Promise.all([
      this.context.rulesOf(hall),
      this.context.categories(hall),
    ]);
    return {
      findings: findingsFor(this.problems(clean(dto), rules, categories), new Set(dto.changed)),
    };
  }

  /** Replaces the saved plan with this one, when nothing in it breaks a rule. */
  async save(
    eventId: string,
    eventHallId: string,
    dto: SavePlanDto,
    user: SessionUser,
  ): Promise<StallPlanView> {
    const hall = await this.context.eventHall(eventId, eventHallId, user);
    this.assertCanEdit(hall, user, await this.row(this.db.manager, eventHallId));
    const [rules, categories] = await Promise.all([
      this.context.rulesOf(hall),
      this.context.categories(hall),
    ]);
    const content = clean(dto);
    const problems = this.problems(content, rules, categories);
    if (problems.length) throw new BadRequestException(refusal(problems));

    const view = await this.db.transaction(async (em) => {
      const plan = await this.lock(em, eventHallId, true);
      // The edit may not run while the plan waits for ITPO, or after the event was cancelled.
      this.assertCanEdit(hall, user, plan);
      if (plan.revision !== dto.revision) {
        throw new ConflictException(
          'Someone saved this plan after you opened it. Reload the planner to see their changes.',
        );
      }
      await em.query(
        `UPDATE idp."T_STALL_PLAN"
            SET content = $2::jsonb, revision = revision + 1, updated_by = $3, updated_at = NOW()
          WHERE event_hall_id = $1`,
        [eventHallId, JSON.stringify(content), user.id],
      );
      return this.viewOf(em, eventHallId);
    });
    await this.audit.record(user, {
      action: 'plan.saved',
      event: { id: hall.eventId, name: hall.eventName },
      hall: { id: eventHallId, name: hall.hallName },
      detail: `Version ${view.revision}`,
    });
    return view;
  }

  /** Writes the saved plan's stalls to ITPO's `T_STALLS`: that revision becomes the one that counts. */
  async publish(
    eventId: string,
    eventHallId: string,
    dto: PublishPlanDto,
    user: SessionUser,
  ): Promise<StallPlanView> {
    const hall = await this.context.eventHall(eventId, eventHallId, user);
    const rules = await this.context.rulesOf(hall);
    const categories = await this.context.categories(hall);

    const view = await this.db.transaction(async (em) => {
      const row = await this.lock(em, eventHallId, true);
      this.assertCanEdit(hall, user, row, true);
      if (row.revision === 0) throw new BadRequestException('Save the plan before publishing it.');
      if (row.revision !== dto.revision) {
        throw new ConflictException(
          'The saved plan changed after you opened it. Reload the planner, then publish.',
        );
      }
      if (hall.kind === 'external') {
        const approved = row.review_status === 'approved' && row.review_revision === row.revision;
        if (!approved) {
          throw new BadRequestException(
            `Version ${row.revision} is not approved. Send it for approval first.`,
          );
        }
      }
      const saved = planView(row);
      const problems = this.problems(saved, rules, categories);
      if (problems.length) {
        throw new BadRequestException(refusal(problems, 'published'));
      }

      await this.writeStalls(em, hall, row, saved);
      await em.query(
        `UPDATE idp."T_STALL_PLAN"
            SET published_revision = revision, published_at = NOW(), published_by = $2
          WHERE event_hall_id = $1`,
        [eventHallId, user.id],
      );
      return this.viewOf(em, eventHallId);
    });
    await this.audit.record(user, {
      action: 'plan.published',
      event: { id: hall.eventId, name: hall.eventName },
      hall: { id: eventHallId, name: hall.hallName },
      detail: `Version ${view.published?.revision ?? view.revision}`,
    });
    return view;
  }

  /** The organiser sends the saved plan to ITPO for approval. */
  async submit(
    eventId: string,
    eventHallId: string,
    dto: PublishPlanDto,
    user: SessionUser,
  ): Promise<StallPlanView> {
    const hall = await this.context.eventHall(eventId, eventHallId, user);
    if (hall.kind !== 'external') {
      throw new BadRequestException(
        'Plans of internal events are published, not sent for approval.',
      );
    }
    const rules = await this.context.rulesOf(hall);
    const categories = await this.context.categories(hall);

    const view = await this.db.transaction(async (em) => {
      const row = await this.lock(em, eventHallId, true);
      this.assertCanEdit(hall, user, row, true);
      if (row.revision === 0) {
        throw new BadRequestException('Save the plan before sending it for approval.');
      }
      if (row.review_status === 'submitted') {
        throw new ConflictException('This plan is already waiting for approval.');
      }
      if (row.revision !== dto.revision) {
        throw new ConflictException(
          'The saved plan changed after you opened it. Reload the planner, then send it.',
        );
      }
      if (row.published_revision === row.revision) {
        throw new BadRequestException('This plan is approved and published as it is.');
      }
      if (row.review_status === 'approved' && row.review_revision === row.revision) {
        throw new BadRequestException('This plan is approved. Publish it.');
      }
      const problems = this.problems(planView(row), rules, categories);
      if (problems.length) {
        throw new BadRequestException(refusal(problems, 'sent'));
      }
      await em.query(
        `UPDATE idp."T_STALL_PLAN"
            SET review_status = 'submitted', review_revision = revision, submitted_at = NOW(),
                submitted_by = $2, reviewed_at = NULL, reviewed_by = NULL, review_note = NULL
          WHERE event_hall_id = $1`,
        [eventHallId, user.id],
      );
      await em.query(`DELETE FROM idp."T_STALL_PLAN_ATTACHMENT" WHERE event_hall_id = $1`, [
        eventHallId,
      ]);
      return this.viewOf(em, eventHallId);
    });
    await this.audit.record(user, {
      action: 'plan.submitted',
      event: { id: hall.eventId, name: hall.eventName },
      hall: { id: eventHallId, name: hall.hallName },
      detail: `Version ${view.revision}`,
    });
    void this.notify.submitted(hall, user);
    return view;
  }

  /** The organiser takes back a plan that waits for approval, to change it. */
  async withdraw(eventId: string, eventHallId: string, user: SessionUser): Promise<StallPlanView> {
    const hall = await this.context.eventHall(eventId, eventHallId, user);
    const view = await this.db.transaction(async (em) => {
      const row = await this.lock(em, eventHallId, true);
      this.assertCanEdit(hall, user, row, true);
      if (row.review_status !== 'submitted') {
        throw new ConflictException('This plan is not waiting for approval.');
      }
      await em.query(
        `UPDATE idp."T_STALL_PLAN"
            SET review_status = NULL, review_revision = NULL, submitted_at = NULL, submitted_by = NULL,
                reviewed_at = NULL, reviewed_by = NULL, review_note = NULL
          WHERE event_hall_id = $1`,
        [eventHallId],
      );
      return this.viewOf(em, eventHallId);
    });
    await this.audit.record(user, {
      action: 'plan.withdrawn',
      event: { id: hall.eventId, name: hall.eventName },
      hall: { id: eventHallId, name: hall.hallName },
      detail: null,
    });
    void this.notify.withdrawn(hall, user);
    return view;
  }

  /**
   * ITPO staff approve the plan that waits, or send it back with a note. Approving does not
   * publish it: the organiser does that. Approval checks the rules again, as they may have
   * changed since the plan was sent.
   */
  async review(
    eventId: string,
    eventHallId: string,
    dto: PublishPlanDto | RejectPlanDto,
    approve: boolean,
    user: SessionUser,
    proof: ProofFile[] = [],
  ): Promise<StallPlanView> {
    if (isOrganiser(user)) {
      throw new ForbiddenException('ITPO’s team approves the plans of external events.');
    }
    const hall = await this.context.eventHall(eventId, eventHallId, user);
    if (hall.kind !== 'external') {
      throw new ForbiddenException('Only the plans of external events are approved.');
    }
    const rules = await this.context.rulesOf(hall);
    const categories = await this.context.categories(hall);
    const note = 'note' in dto ? dto.note : null;

    const view = await this.db.transaction(async (em) => {
      const row = await this.lock(em, eventHallId, true);
      if (row.review_status !== 'submitted') {
        throw new ConflictException('This plan is not waiting for approval.');
      }
      if (row.review_revision !== dto.revision) {
        throw new ConflictException(
          'The organiser changed what waits for approval. Reload the planner to see it.',
        );
      }
      if (approve) {
        const problems = this.problems(planView(row), rules, categories);
        if (problems.length) {
          throw new BadRequestException(
            refusal(problems).replace(
              'The plan was not saved',
              'The plan cannot be approved; send it back',
            ),
          );
        }
      }
      await em.query(
        `UPDATE idp."T_STALL_PLAN"
            SET review_status = $2, reviewed_at = NOW(), reviewed_by = $3, review_note = $4
          WHERE event_hall_id = $1`,
        [eventHallId, approve ? 'approved' : 'rejected', user.id, note],
      );
      await em.query(`DELETE FROM idp."T_STALL_PLAN_ATTACHMENT" WHERE event_hall_id = $1`, [
        eventHallId,
      ]);
      for (const file of approve ? [] : proof) {
        await em.query(
          `INSERT INTO idp."T_STALL_PLAN_ATTACHMENT"
             (event_hall_id, revision, file_name, mime_type, size, data, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [eventHallId, dto.revision, file.name, file.mimeType, file.size, file.data, user.id],
        );
      }
      return this.viewOf(em, eventHallId);
    });
    await this.audit.record(user, {
      action: approve ? 'plan.approved' : 'plan.rejected',
      event: { id: hall.eventId, name: hall.eventName },
      hall: { id: eventHallId, name: hall.hallName },
      detail: approve
        ? `Version ${dto.revision}`
        : `Version ${dto.revision}: ${note ?? ''}${proof.length ? ` (${proof.length} file${proof.length === 1 ? '' : 's'})` : ''}`,
    });
    void (approve
      ? this.notify.approved(hall)
      : this.notify.rejected(hall, note ?? '', proof.length));
    return view;
  }

  /** ITPO staff take an approved hall back to Draft, so its plan can change and be sent again. */
  async reopen(eventId: string, eventHallId: string, user: SessionUser): Promise<StallPlanView> {
    if (isOrganiser(user)) {
      throw new ForbiddenException('ITPO’s team reopens the plans of external events.');
    }
    const hall = await this.context.eventHall(eventId, eventHallId, user);
    if (hall.kind !== 'external') {
      throw new ForbiddenException('Only the plans of external events are approved.');
    }
    const view = await this.db.transaction(async (em) => {
      const row = await this.lock(em, eventHallId, true);
      if (row.review_status !== 'approved' || row.review_revision !== row.revision) {
        throw new ConflictException('Only an approved plan can be reopened.');
      }
      await em.query(
        `UPDATE idp."T_STALL_PLAN"
            SET review_status = NULL, review_revision = NULL, submitted_at = NULL, submitted_by = NULL,
                reviewed_at = NULL, reviewed_by = NULL, review_note = NULL
          WHERE event_hall_id = $1`,
        [eventHallId],
      );
      return this.viewOf(em, eventHallId);
    });
    await this.audit.record(user, {
      action: 'plan.reopened',
      event: { id: hall.eventId, name: hall.eventName },
      hall: { id: eventHallId, name: hall.hallName },
      detail: null,
    });
    void this.notify.reopened(hall);
    return view;
  }

  /** One proof file of a rejected plan, for the reader who may open the plan. */
  async attachment(
    eventId: string,
    eventHallId: string,
    id: string,
    user: SessionUser,
  ): Promise<{ name: string; mimeType: string; data: Buffer }> {
    await this.context.eventHall(eventId, eventHallId, user);
    const [file] = await this.db.query<
      Array<{ file_name: string; mime_type: string; data: Buffer }>
    >(
      `SELECT file_name, mime_type, data FROM idp."T_STALL_PLAN_ATTACHMENT"
        WHERE id = $1 AND event_hall_id = $2`,
      [id, eventHallId],
    );
    if (!file) throw new NotFoundException('That file was not found.');
    return { name: file.file_name, mimeType: file.mime_type, data: file.data };
  }

  /** Every hall of an event with where its plan stands, and what this user may do next. */
  async statuses(eventId: string, user: SessionUser): Promise<HallPlanStatus[]> {
    const halls = await this.db.query<Array<{ id: string }>>(
      `SELECT id FROM idp."T_EVENT_HALL"
        WHERE booking_id = $1 AND (cancellation_status IS NULL OR cancellation_status = '')
        ORDER BY hall_name`,
      [eventId],
    );
    const out: HallPlanStatus[] = [];
    for (const { id } of halls) {
      const hall = await this.context.eventHall(eventId, id, user);
      const row = await this.row(this.db.manager, id);
      const access = this.access(hall, user, row);
      const plan = planView(
        row,
        row?.review_status === 'rejected' ? await this.attachments(this.db.manager, id) : [],
      );
      let violations = 0;
      if (hall.kind === 'external' && plan.revision > 0) {
        const [rules, categories] = await Promise.all([
          this.context.rulesOf(hall),
          this.context.categories(hall),
        ]);
        violations = this.problems(plan, rules, categories).length;
      }
      out.push({
        eventHallId: id,
        hallName: hall.hallName,
        status: planStatus(hall.kind, plan),
        revision: plan.revision,
        stalls: plan.stalls.filter((s) => s.isActive).length,
        updatedAt: plan.updatedAt,
        review: plan.review,
        published: plan.published,
        violations,
        canSubmit: access.canSubmit,
        canWithdraw: access.canWithdraw,
        canApprove: access.canApprove,
        canReopen: access.canReopen,
      });
    }
    return out;
  }

  /** How many external plans wait for ITPO's answer, for ITPO staff. */
  async pendingCount(user: SessionUser): Promise<number> {
    if (isOrganiser(user)) return 0;
    const [row] = await this.db.query<Array<{ n: string }>>(
      `SELECT count(*) AS n
         FROM idp."T_STALL_PLAN" p
         JOIN idp."T_EVENT_HALL" eh ON eh.id = p.event_hall_id
         JOIN idp."T_HALL_BOOKING" b ON b.id = eh.booking_id
        WHERE p.review_status = 'submitted'
          AND (eh.cancellation_status IS NULL OR eh.cancellation_status = '')
          AND coalesce(b.event_booking_type, '') <> 'internal'`,
    );
    return Number(row?.n ?? 0);
  }

  // ---- helpers ----------------------------------------------------------------------------

  /**
   * A hall nobody has planned here yet, but whose stalls ITPO already has, opens with them: they
   * are plotted for the planner to change. Nothing is written until the planner saves.
   */
  private async withExistingStalls(
    plan: StallPlanView,
    hall: PlanEventHall,
  ): Promise<StallPlanView> {
    // An empty plan that was saved but never published is still unplanned.
    if (plan.stalls.length || plan.published) return plan;
    const rows = await this.db.query<ItpoStallRow[]>(
      `SELECT id, island_number, stall_number, description, location, stall_coordinates, layout_grid,
              category_id, is_premium, is_blocked, is_fnb_stall, is_branding_stall,
              is_horseshoe_stall, is_marquee_available, is_restricted_for_overseas, price
         FROM idp."T_STALLS"
        WHERE is_active = true AND ${HALL_STALLS}
        ORDER BY island_number, stall_number`,
      [hall.eventHallId, hall.eventId, hall.hallId],
    );
    const stalls = rows.flatMap((r) => stallFromItpo(r) ?? []);
    if (rows.length !== stalls.length) {
      this.logger.warn(
        `Event hall ${hall.eventHallId}: ${rows.length - stalls.length} of ${rows.length} ITPO stalls have no usable position and were left out.`,
      );
    }
    return stalls.length ? { ...plan, stalls, imported: true } : plan;
  }

  private access(hall: PlanEventHall, user: SessionUser, row: PlanRow | null): PlanAccess {
    return planAccess({
      kind: hall.kind,
      approvalStatus: hall.approvalStatus,
      cancelled: hall.cancelled,
      organiser: isOrganiser(user),
      revision: row?.revision ?? 0,
      review:
        row?.review_status && row.review_revision
          ? { status: row.review_status, revision: row.review_revision }
          : null,
      publishedRevision: row?.published_revision ?? null,
    });
  }

  /** Refuses what this user may not do; `ignoreWaiting` lets the organiser act on a plan that waits (to withdraw it). */
  private assertCanEdit(
    hall: PlanEventHall,
    user: SessionUser,
    row: PlanRow | null,
    ignoreWaiting = false,
  ): void {
    const access = this.access(hall, user, row);
    const waiting = !access.canEdit && access.canWithdraw;
    if (access.readOnlyReason && !(ignoreWaiting && waiting)) {
      throw new ForbiddenException(access.readOnlyReason);
    }
  }

  /** What makes the plan unsound, then the rules of the event hall. */
  private problems(
    plan: PlanDraft,
    rules: PlanRulesContext,
    categories: readonly PlanCategory[],
  ): PlanFinding[] {
    return [
      ...planStructure(plan, new Set(categories.map((c) => c.id))),
      ...planRules(plan, rules),
    ];
  }

  /** The plan as saved now, with the proof of a rejection. */
  private async viewOf(em: EntityManager, eventHallId: string): Promise<StallPlanView> {
    const row = await this.lock(em, eventHallId, false);
    return planView(
      row,
      row.review_status === 'rejected' ? await this.attachments(em, eventHallId) : [],
    );
  }

  private async attachments(em: EntityManager, eventHallId: string): Promise<AttachmentView[]> {
    const rows = await em.query<
      Array<{ id: string; file_name: string; mime_type: string; size: number }>
    >(
      `SELECT id, file_name, mime_type, size FROM idp."T_STALL_PLAN_ATTACHMENT"
        WHERE event_hall_id = $1 ORDER BY created_at, file_name`,
      [eventHallId],
    );
    return rows.map((r) => ({ id: r.id, name: r.file_name, mimeType: r.mime_type, size: r.size }));
  }

  private async row(em: EntityManager, eventHallId: string): Promise<PlanRow | null> {
    const [row] = await em.query<PlanRow[]>(
      `SELECT * FROM idp."T_STALL_PLAN" WHERE event_hall_id = $1`,
      [eventHallId],
    );
    return row ?? null;
  }

  /** The plan's row, made on first use; locked for a change, so two saves run one after the other. */
  private async lock(em: EntityManager, eventHallId: string, forUpdate: boolean): Promise<PlanRow> {
    if (forUpdate) {
      await em.query(
        `INSERT INTO idp."T_STALL_PLAN" (event_hall_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [eventHallId],
      );
    }
    const [row] = await em.query<PlanRow[]>(
      `SELECT * FROM idp."T_STALL_PLAN" WHERE event_hall_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [eventHallId],
    );
    return row;
  }

  /**
   * Makes the hall's stalls in `T_STALLS` the plan's. A stall is matched by its id, so a booking
   * keeps pointing at it. A stall someone has booked, or has in a cart, may not be removed or moved.
   * A hall that already has stalls ITPO made elsewhere is not overwritten by a first publish.
   */
  private async writeStalls(
    em: EntityManager,
    hall: PlanEventHall,
    row: PlanRow,
    plan: StallPlanView,
  ): Promise<void> {
    const existing = await em.query<
      Array<{
        id: string;
        booking_status: string | null;
        is_active: boolean;
        stall_number: string;
        island_number: string;
        stall_coordinates: unknown;
        layout_grid: unknown;
      }>
    >(
      `SELECT id, booking_status, is_active, stall_number, island_number, stall_coordinates, layout_grid
         FROM idp."T_STALLS" WHERE ${HALL_STALLS} FOR UPDATE`,
      [hall.eventHallId, hall.eventId, hall.hallId],
    );
    const planned = new Set(plan.stalls.map((s) => s.id));
    // Stalls ITPO made elsewhere are protected only while the plan never saw them: a plan that
    // opened with them (see `withExistingStalls`) may change them.
    if (
      row.published_revision === null &&
      existing.some((s) => s.is_active) &&
      !existing.some((s) => s.is_active && planned.has(s.id))
    ) {
      throw new ConflictException(
        `This hall already has ${existing.filter((s) => s.is_active).length} stalls in ITPO that were not planned here. They are not replaced.`,
      );
    }

    const island = (hall.hallCode ?? hall.hallName).trim();
    const categories = new Map(
      [...new Set(plan.stalls.flatMap((s) => s.categoryIds))].map(
        (id) => [id, Number(id)] as const,
      ),
    );
    const published = publishedStallRows(
      hall.eventHallId,
      row.revision,
      plan.stalls,
      null,
      new Map(),
    );
    const rows = published
      .filter((s) => s.isActive)
      .map((s) => ({
        id: s.stallId,
        label: stallLabel(s),
        stall: itpoStall(s, categories, island),
      }));

    const byId = new Map(existing.map((s) => [s.id, s]));
    const keep = new Set(rows.map((r) => r.id));
    const held = (s: { booking_status: string | null }) =>
      s.booking_status === 'Booked' || s.booking_status === 'In-Progress';

    const blocked: string[] = [];
    for (const s of existing) {
      if (keep.has(s.id) || !s.is_active || !held(s)) continue;
      blocked.push(`${s.island_number}${s.stall_number} is booked and cannot be removed.`);
    }
    for (const r of rows) {
      const was = byId.get(r.id);
      if (!was || !held(was)) continue;
      const moved =
        JSON.stringify(was.stall_coordinates) !== JSON.stringify(r.stall.stall_coordinates) ||
        JSON.stringify(was.layout_grid) !== JSON.stringify(r.stall.layout_grid) ||
        was.stall_number !== r.stall.stall_number ||
        was.island_number !== r.stall.island_number;
      if (moved) blocked.push(`${r.label} is booked and cannot be moved, resized or renumbered.`);
    }
    if (blocked.length) {
      throw new ConflictException({
        message: [
          `The plan was not published: ${blocked.length} booked ${blocked.length === 1 ? 'stall' : 'stalls'} would change.`,
          ...blocked,
        ],
      });
    }

    // Stalls taken out of the plan are switched off, not deleted: old bookings may still name them.
    await em.query(
      `UPDATE idp."T_STALLS" SET is_active = false, updated_at = NOW()
        WHERE ${HALL_STALLS} AND is_active = true AND NOT (id = ANY($4::uuid[]))`,
      [hall.eventHallId, hall.eventId, hall.hallId, [...keep]],
    );
    for (const r of rows) {
      await upsertStall(em, hall, r.id, r.stall, byId.has(r.id));
    }
  }
}

/**
 * The stalls of an event hall, as SelfCare finds them: by the event hall, or by the event and the
 * hall (older rows name an event hall that no longer exists). Parameters: event hall, event, hall.
 */
const HALL_STALLS = `(event_hall_id = $1 OR (event_id = $2 AND hall_id = $3))`;

export type PlanStatus = 'not_started' | 'draft' | 'planned' | 'pending' | 'approved' | 'rejected';

/** Where a plan stands: the BRD's statuses. An internal plan is Planned once saved; there is no approval. */
export function planStatus(kind: 'internal' | 'external', plan: StallPlanView): PlanStatus {
  if (plan.revision === 0) return 'not_started';
  if (kind === 'internal') return 'planned';
  const review = plan.review;
  if (review?.status === 'submitted') return 'pending';
  if (review?.status === 'approved' && review.revision === plan.revision) return 'approved';
  if (review?.status === 'rejected' && review.revision === plan.revision) return 'rejected';
  return 'draft';
}

/** One hall of an event, for the event page. */
export interface HallPlanStatus {
  eventHallId: string;
  hallName: string;
  status: PlanStatus;
  revision: number;
  stalls: number;
  updatedAt: string | null;
  review: PlanReviewView | null;
  published: { revision: number; at: string } | null;
  /** Rules the saved plan breaks; Send for approval waits until there are none. */
  violations: number;
  canSubmit: boolean;
  canWithdraw: boolean;
  canApprove: boolean;
  canReopen: boolean;
}

function isOrganiser(user: SessionUser): boolean {
  return user.type === UserType.Organiser;
}

async function upsertStall(
  em: EntityManager,
  hall: PlanEventHall,
  id: string,
  s: ItpoStall,
  exists: boolean,
): Promise<void> {
  const values = [
    s.stall_name,
    s.stall_number,
    s.island_number,
    s.description ?? null,
    JSON.stringify(s.stall_coordinates),
    JSON.stringify(s.layout_grid),
    s.no_of_open_sides,
    s.category_id,
    s.is_premium,
    s.is_blocked,
    s.is_fnb_stall,
    s.is_branding_stall,
    s.is_horseshoe_stall,
    s.is_marquee_available,
    s.is_restricted_for_overseas,
    s.location ?? null,
    s.price,
  ];
  if (exists) {
    await em.query(
      `UPDATE idp."T_STALLS"
          SET stall_name = $2, stall_number = $3, island_number = $4, description = $5,
              stall_coordinates = $6::jsonb, layout_grid = $7::jsonb, no_of_open_sides = $8,
              category_id = $9::int[], is_premium = $10, is_blocked = $11, is_fnb_stall = $12,
              is_branding_stall = $13, is_horseshoe_stall = $14, is_marquee_available = $15,
              is_restricted_for_overseas = $16, location = $17, price = $18, is_active = true,
              updated_at = NOW()
        WHERE id = $1`,
      [id, ...values],
    );
    return;
  }
  await em.query(
    `INSERT INTO idp."T_STALLS"
       (id, stall_name, stall_number, island_number, description, stall_coordinates, layout_grid,
        no_of_open_sides, category_id, is_premium, is_blocked, is_fnb_stall, is_branding_stall,
        is_horseshoe_stall, is_marquee_available, is_restricted_for_overseas, location, price,
        hall_id, event_id, event_hall_id, status, booking_status, is_active)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::int[], $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20, $21, 1, 'Available', true)`,
    [id, ...values, hall.hallId, hall.eventId, hall.eventHallId],
  );
}

/** The plan as saved: zones with their area, stalls and seats and drawings with only what is stored. */
function clean(dto: SavePlanDto | CheckPlanDto): PlanContent {
  return {
    zones: dto.zones.map((z) => ({
      id: z.id,
      name: z.name,
      color: z.color.toLowerCase(),
      polygon: z.polygon,
      area: Math.round(ringArea(z.polygon) * 100) / 100,
    })),
    stalls: dto.stalls.map((s) => ({
      id: s.id,
      zoneId: s.zoneId ?? null,
      islandNumber: s.islandNumber ?? null,
      stallNumber: s.stallNumber,
      x: s.x,
      y: s.y,
      width: s.width,
      depth: s.depth,
      openSides: [...new Set(s.openSides)],
      cutCells: cleanCutCells(s, s.cutCells ?? []),
      labelArea: s.labelArea ?? null,
      price: s.price ?? null,
      scheme: s.scheme,
      categoryIds: [...new Set(s.categoryIds)],
      isPremium: s.isPremium,
      isBlocked: s.isBlocked,
      isFnb: s.isFnb,
      isBranding: s.isBranding,
      isHorseshoe: s.isHorseshoe,
      isMarqueeAvailable: s.isMarqueeAvailable,
      isRestrictedForOverseas: s.isRestrictedForOverseas,
      isActive: s.isActive,
      location: s.location ?? null,
      description: s.description ?? null,
    })),
    seats: dto.seats.map((s) => ({
      id: s.id,
      zoneId: s.zoneId ?? null,
      rowLabel: s.rowLabel,
      seatNumber: s.seatNumber,
      x: s.x,
      y: s.y,
      width: s.width,
      depth: s.depth,
      categoryId: s.categoryId ?? null,
    })),
    objects: dto.objects.map((o) => ({
      id: o.id,
      kind: o.kind,
      points: o.points,
      text: o.text ?? null,
      color: o.color.toLowerCase(),
    })),
  };
}

function planView(row: PlanRow | null, attachments: AttachmentView[] = []): StallPlanView {
  const content = row?.content ?? EMPTY;
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    ...content,
    revision: row?.revision ?? 0,
    updatedAt: row && row.revision > 0 ? iso(row.updated_at) : null,
    published:
      row?.published_revision && row.published_at
        ? { revision: row.published_revision, at: iso(row.published_at)! }
        : null,
    imported: false,
    review:
      row?.review_status && row.review_revision && row.submitted_at
        ? {
            status: row.review_status,
            revision: row.review_revision,
            submittedAt: iso(row.submitted_at)!,
            reviewedAt: iso(row.reviewed_at),
            note: row.review_note,
            attachments: row.review_status === 'rejected' ? attachments : [],
          }
        : null,
  };
}
