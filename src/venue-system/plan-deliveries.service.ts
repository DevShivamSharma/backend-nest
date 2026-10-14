import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import { StallCategoryEntity } from '../categories/category.entity';
import { openSecret } from '../common/sealed-secret';
import type { Actor, OrgAccessContext } from '../common/http/authenticated-request';
import type { VenueSystemConfig } from '../config/configuration';
import { EventEntity, EventHallEntity } from '../events/event.entity';
import { EventsService } from '../events/events.service';
import { ExternalRefEntity } from '../integrations/external-ref.entity';
import { PublishedStallEntity, StallPlanEntity } from '../stall-plans/stall-plan.entity';
import { HallEntity } from '../venues/hall.entity';
import { itpoPushBody, itpoPushProblems } from './itpo-stall-push';
import { PlanDeliveryEntity } from './plan-delivery.entity';
import { VenueSystemIntegrationEntity } from './venue-system-integration.entity';
import type { PlanDeliveriesView, PlanDeliveryView } from './venue-system.views';
import {
  answerText,
  classifyAnswer,
  VENUE_TRANSPORT,
  type VenueTransport,
} from './venue-transport';

/** Rows one worker pass sends. */
const BATCH = 20;
/** A claimed row is someone's for this long; after it, the send is presumed dead and redone. */
const LEASE_MINUTES = 10;
/** Waits after the 1st…6th failed send; after the 7th, the delivery fails (ruling 3). */
const BACKOFF_MINUTES = [1, 5, 30, 120, 720, 1440];
/** Deliveries a hall's list shows. */
const LISTED = 20;

const NO_LINK = 'No venue system is linked to this organisation yet.';
const LINK_OFF = 'The venue system link is switched off.';

type ClaimedRow = { id: string; organisation_id: string; payload: string; attempts: number };

/**
 * Flow 1 (docs/15 §4): the published plan of an internal event that sells through the venue's
 * system is pushed there. Publishing writes an outbox row (`plan_deliveries`); the worker sends
 * it, signed, and retries what the venue could not take yet. The venue's answer is kept on the
 * row, so the planner can say whether SelfCare has the plan.
 */
@Injectable()
export class PlanDeliveriesService {
  private readonly logger = new Logger(PlanDeliveriesService.name);
  /** Opens the venue secrets; null when INTEGRATION_SECRET_KEY is unset. Never logged. */
  private readonly key: Buffer | null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly audit: AuditService,
    @Inject(VENUE_TRANSPORT) private readonly transport: VenueTransport,
    config: ConfigService,
  ) {
    this.key = config.getOrThrow<VenueSystemConfig>('venueSystem').secretKey;
  }

  /**
   * Called by `StallPlansService.publish` inside its transaction (the outbox): the delivery row
   * commits with the publish or not at all, and the worker sends it later, so a publish never
   * waits on the venue's server. Only an internal event that sells through the venue system, of
   * an organisation whose link is on, is pushed. A plan that cannot be pushed (no booking id,
   * no hall id, unmapped categories) still publishes; its row says why it was not sent.
   */
  async enqueue(
    em: EntityManager,
    event: EventEntity,
    eventHall: EventHallEntity,
    actorId: string,
  ): Promise<void> {
    if (event.kind !== 'internal' || event.bookingChannel !== 'venue_system') return;
    const link = await em
      .getRepository(VenueSystemIntegrationEntity)
      .findOneBy({ organisationId: event.organisationId });
    if (!link?.enabled) return;
    await this.supersede(em, eventHall.id);
    await this.insert(em, event, eventHall, actorId, null);
  }

  /** The pushes of one event hall, newest first, and whether the newest may be sent again. */
  async list(access: OrgAccessContext, id: string, hallId: string): Promise<PlanDeliveriesView> {
    const { event, row } = await this.events.eventHallOf(access, id, hallId);
    const em = this.dataSource.manager;
    const pushes = event.kind === 'internal' && event.bookingChannel === 'venue_system';
    const reason = pushes ? await this.notPushedReason(em, event.organisationId) : null;
    const rows = await em.getRepository(PlanDeliveryEntity).find({
      where: { eventHallId: row.id },
      order: { createdAt: 'DESC' },
      take: LISTED,
    });
    const latest = rows[0];
    return {
      pushes,
      reason,
      canResend:
        pushes &&
        !reason &&
        access.permissions.includes('layouts.publish') &&
        !EventsService.isOrganiser(access) &&
        latest?.status === 'failed',
      deliveries: rows.map((d) => PlanDeliveriesService.view(d)),
    };
  }

  /**
   * Sends the hall's plan again after its latest delivery failed (ruling 1): a new delivery with
   * a new id, built again from what is published now, so a fixed hall id or category mapping is
   * picked up.
   */
  async resend(
    access: OrgAccessContext,
    id: string,
    hallId: string,
    deliveryId: string,
    actor: Actor,
  ): Promise<PlanDeliveriesView> {
    const { event, row } = await this.events.eventHallOf(access, id, hallId);
    if (EventsService.isOrganiser(access)) {
      throw new ForbiddenException('The venue’s own team sends plans to SelfCare.');
    }
    EventsService.assertOpen(event);
    await this.dataSource.transaction(async (em) => {
      // The same lock `publish` takes, so a resend and a publish of one hall run one at a time.
      const plan = await em.getRepository(StallPlanEntity).findOne({
        where: { eventHallId: row.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (event.kind !== 'internal' || event.bookingChannel !== 'venue_system') {
        throw new ConflictException(
          "This event's stalls are not sold through the venue system.",
        );
      }
      const reason = await this.notPushedReason(em, event.organisationId);
      if (reason) throw new ConflictException(reason);
      if (plan?.publishedRevision == null) {
        throw new ConflictException('The plan is not published, so there is nothing to send.');
      }
      const latest = await em.getRepository(PlanDeliveryEntity).findOne({
        where: { eventHallId: row.id },
        order: { createdAt: 'DESC' },
      });
      if (!latest || latest.id !== deliveryId) {
        throw new ConflictException(
          'Only the latest delivery of this hall can be sent again. Reload to see it.',
        );
      }
      if (latest.status === 'pending' || latest.status === 'sending') {
        throw new ConflictException("This version is being sent; wait for SelfCare's answer.");
      }
      if (latest.status === 'delivered') {
        throw new ConflictException(
          'SelfCare already has this version. Publish a new one to send again.',
        );
      }
      await this.supersede(em, row.id);
      const sent = await this.insert(em, event, row, actor.id, latest.id);
      const hall = await em.getRepository(HallEntity).findOneBy({ id: row.hallId });
      await this.audit.record(
        {
          action: 'plan.delivery_resent',
          actor,
          organisationId: access.organisation.id,
          targetType: 'event',
          targetId: event.id,
          metadata: {
            hall: hall?.name ?? null,
            revision: sent.planRevision,
            deliveryId: sent.id,
            previous: latest.id,
          },
        },
        em,
      );
    });
    return this.list(access, id, hallId);
  }

  /**
   * Claims due rows and sends them. The claim is one statement: it locks up to BATCH due rows
   * with SKIP LOCKED (another instance takes others), flips them to `sending` with a lease and
   * counts the attempt, and commits, so no lock is held while the venue answers. A `sending` row
   * whose lease ran out was claimed by a process that died; it is sent again, which is safe
   * because the venue dedupes on the delivery id. The CTE ends in a SELECT because TypeORM
   * returns `[rows, count]` for a top-level UPDATE but plain rows for a SELECT.
   */
  async sendDue(): Promise<number> {
    const claimed: ClaimedRow[] = await this.dataSource.query(
      `WITH due AS (
         SELECT id FROM plan_deliveries
          WHERE status IN ('pending', 'sending') AND next_attempt_at <= now()
          ORDER BY next_attempt_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE plan_deliveries d
            SET status = 'sending', attempts = d.attempts + 1,
                next_attempt_at = now() + make_interval(mins => $2::int), updated_at = now()
           FROM due
          WHERE d.id = due.id
         RETURNING d.id, d.organisation_id, d.payload, d.attempts
       )
       SELECT * FROM claimed`,
      [BATCH, LEASE_MINUTES],
    );
    for (const row of claimed) {
      try {
        await this.sendOne(row);
      } catch (error) {
        // The row keeps its lease and is sent again when it runs out.
        this.logger.error(
          `Could not send plan delivery ${row.id}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return claimed.length;
  }

  private async sendOne(row: ClaimedRow): Promise<void> {
    const link = await this.dataSource
      .getRepository(VenueSystemIntegrationEntity)
      .findOneBy({ organisationId: row.organisation_id });
    if (!link?.enabled) {
      return this.finish(row.id, { status: 'failed', lastError: LINK_OFF });
    }
    if (!this.key) {
      return this.finish(row.id, {
        status: 'failed',
        lastError: 'INTEGRATION_SECRET_KEY is not set on the server, so the push cannot be signed.',
      });
    }
    let secret: string;
    try {
      secret = openSecret(link.secretSealed, this.key, link.organisationId);
    } catch {
      return this.finish(row.id, {
        status: 'failed',
        lastError:
          'The venue secret does not open with this server’s INTEGRATION_SECRET_KEY. Set the secret again.',
      });
    }
    const answer = await this.transport.send({
      url: link.callbackUrl,
      deliveryId: row.id,
      body: row.payload,
      secret,
    });
    if (answer.logged) return this.finish(row.id, { status: 'delivered' });
    const outcome = classifyAnswer(answer.status);
    if (outcome === 'delivered') {
      return this.finish(row.id, {
        status: 'delivered',
        statusCode: answer.status,
        warnings: answer.warnings,
      });
    }
    const said = answerText(answer);
    const wait = BACKOFF_MINUTES[row.attempts - 1];
    if (outcome === 'refused' || wait === undefined) {
      return this.finish(row.id, {
        status: 'failed',
        statusCode: answer.status,
        venueCode: answer.code,
        lastError: outcome === 'refused' ? said : `Gave up after ${row.attempts} attempts. ${said}`,
      });
    }
    this.logger.warn(`Plan delivery ${row.id}: ${said} Next try in ${wait} min.`);
    return this.finish(row.id, {
      status: 'pending',
      statusCode: answer.status,
      venueCode: answer.code,
      lastError: said,
      retryInMinutes: wait,
    });
  }

  /** Writes an answer, only onto a row still ours: a superseded row stays as it is. */
  private async finish(
    id: string,
    f: {
      status: 'pending' | 'delivered' | 'failed';
      statusCode?: number | null;
      venueCode?: string | null;
      lastError?: string | null;
      retryInMinutes?: number;
      warnings?: string[];
    },
  ): Promise<void> {
    // `$2::text` everywhere: without one type, Postgres deduces varchar from `status = $2` and
    // text from `$2 = 'pending'`, and refuses the statement.
    await this.dataSource.query(
      `UPDATE plan_deliveries
          SET status = $2::text,
              last_status_code = $3, venue_code = $4, last_error = $5,
              next_attempt_at = CASE WHEN $2::text = 'pending'
                                     THEN now() + make_interval(mins => $6::int) END,
              delivered_at = CASE WHEN $2::text = 'delivered' THEN now() END,
              warnings = $7::text[],
              updated_at = now()
        WHERE id = $1 AND status = 'sending'`,
      [
        id,
        f.status,
        f.statusCode ?? null,
        f.venueCode ?? null,
        f.lastError?.slice(0, 500) ?? null,
        f.retryInMinutes ?? 0,
        f.warnings ?? [],
      ],
    );
  }

  /**
   * Only the newest revision is worth sending; SelfCare answers 409 STALE_REVISION to an older
   * one anyway. A row being sent right now is marked too: `finish` only writes rows still
   * `sending`, so its answer does not undo this.
   */
  private async supersede(em: EntityManager, eventHallId: string): Promise<void> {
    await em.query(
      `UPDATE plan_deliveries
          SET status = 'failed', last_error = 'superseded', next_attempt_at = NULL,
              updated_at = now()
        WHERE event_hall_id = $1 AND status IN ('pending', 'sending')`,
      [eventHallId],
    );
  }

  private async insert(
    em: EntityManager,
    event: EventEntity,
    eventHall: EventHallEntity,
    actorId: string,
    resentFromId: string | null,
  ): Promise<PlanDeliveryEntity> {
    // The id is made here because it is inside the body the venue verifies.
    const id = randomUUID();
    const built = await this.build(em, event, eventHall, id);
    const repo = em.getRepository(PlanDeliveryEntity);
    return repo.save(
      repo.create({
        id,
        organisationId: event.organisationId,
        eventId: event.id,
        eventHallId: eventHall.id,
        kind: 'plan.published',
        planRevision: built.revision,
        payload: built.body,
        status: built.body ? 'pending' : 'failed',
        attempts: 0,
        nextAttemptAt: built.body ? new Date() : null,
        lastError: built.problems.length ? built.problems.join(' ').slice(0, 500) : null,
        resentFromId,
        createdById: actorId,
      }),
    );
  }

  /**
   * The body for SelfCare, built from what is published now, or why it cannot be. Every read
   * goes through `em`, so inside `publish` the rows that publish just wrote are seen.
   */
  private async build(
    em: EntityManager,
    event: EventEntity,
    eventHall: EventHallEntity,
    deliveryId: string,
  ): Promise<{ revision: number; body: string | null; problems: string[] }> {
    const plan = await em.getRepository(StallPlanEntity).findOneBy({ eventHallId: eventHall.id });
    if (!plan?.publishedRevision || !plan.publishedAt) {
      // Callers publish or check the published revision first; this is a programming error.
      throw new Error(`The plan of event hall ${eventHall.id} is not published.`);
    }
    const stalls = await em
      .getRepository(PublishedStallEntity)
      .findBy({ eventHallId: eventHall.id });
    const hall = await em.getRepository(HallEntity).findOneByOrFail({ id: eventHall.hallId });
    const refs = em.getRepository(ExternalRefEntity);
    const hallRef = await refs.findOneBy({
      organisationId: event.organisationId,
      system: 'itpo',
      entityType: 'hall',
      localId: hall.id,
    });
    const categoryIds = [...new Set(stalls.flatMap((s) => s.categoryIds))];
    const categories = new Map<string, number>();
    const categoryNames = new Map<string, string>();
    if (categoryIds.length) {
      const categoryRefs = await refs.findBy({
        organisationId: event.organisationId,
        system: 'itpo',
        entityType: 'category',
        localId: In(categoryIds),
      });
      for (const ref of categoryRefs) {
        // A non-numeric id is no `T_CODE_MASTER` id: the category then counts as unmapped.
        if (/^\d+$/.test(ref.externalId)) categories.set(ref.localId, Number(ref.externalId));
      }
      const named = await em.getRepository(StallCategoryEntity).findBy({ id: In(categoryIds) });
      for (const c of named) categoryNames.set(c.id, c.name);
    }
    const input = {
      deliveryId,
      sentAt: new Date(),
      event: { id: event.id, name: event.name, venueEventId: event.venueEventId },
      hall: {
        id: hall.id,
        name: hall.name,
        itpoId: hallRef?.externalId ?? null,
        floorVersion: eventHall.floorVersion,
      },
      plan: { revision: plan.publishedRevision, publishedAt: plan.publishedAt },
      stalls,
      categories,
      categoryNames,
    };
    const problems = itpoPushProblems(input);
    return {
      revision: plan.publishedRevision,
      body: problems.length ? null : JSON.stringify(itpoPushBody(input)),
      problems,
    };
  }

  /** Why an organisation's publishes are not pushed: no link, or the link is off. */
  private async notPushedReason(em: EntityManager, organisationId: string): Promise<string | null> {
    const link = await em
      .getRepository(VenueSystemIntegrationEntity)
      .findOneBy({ organisationId });
    if (!link) return NO_LINK;
    return link.enabled ? null : LINK_OFF;
  }

  private static view(d: PlanDeliveryEntity): PlanDeliveryView {
    return {
      id: d.id,
      revision: d.planRevision,
      status: d.status,
      attempts: d.attempts,
      nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null,
      lastStatusCode: d.lastStatusCode,
      venueCode: d.venueCode,
      lastError: d.lastError,
      warnings: d.warnings ?? [],
      deliveredAt: d.deliveredAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
      resentFromId: d.resentFromId,
    };
  }
}
