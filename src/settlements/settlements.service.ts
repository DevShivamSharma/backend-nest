import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor, OrgAccessContext } from '../common/http/authenticated-request';
import type { EventEntity } from '../events/event.entity';
import { EventsService } from '../events/events.service';
import type { PaymentStatus } from '../payments/payment.entity';
import { PayoutDto } from './dto/settlement.dto';
import { type PaymentLine, settlementFigures } from './settlement-figures';
import { SettlementEntity } from './settlement.entity';
import type { SettlementPaymentView, SettlementView } from './settlement.views';

/**
 * What the platform owes the payee of a platform-portal event (docs/15 §3.4, §6.3). Figures are
 * summed live from payments and refunds while the event is open. The settlement row is born at
 * close (ruling 1), with the figures frozen; recording the bank transfer settles it.
 *
 * Lock order: the event row (write) first, as staff refunds take it shared, so none starts while
 * the figures freeze; then the settlement row.
 */
@Injectable()
export class SettlementsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  async get(access: OrgAccessContext, eventId: string): Promise<SettlementView> {
    const em = this.dataSource.manager;
    const event = await this.events.eventFor(em, access, eventId);
    SettlementsService.assertSettles(event);
    const row = await em.getRepository(SettlementEntity).findOneBy({ eventId: event.id });
    const lines = await this.lines(em, event);
    const figures = row
      ? {
          grossPaise: row.grossPaise,
          refundedPaise: row.refundedPaise,
          gatewayFeePaise: row.gatewayFeePaise,
          platformFeePercent: row.platformFeePercent,
          platformFeePaise: row.platformFeePaise,
          netPayablePaise: row.netPayablePaise,
        }
      : settlementFigures(lines, access.organisation.platformFeePercent);
    return {
      eventId: event.id,
      status: row?.status ?? 'open',
      figures,
      feeUnknown: lines.filter((l) => l.feePaise === null).length,
      closeRefusal: SettlementsService.closeRefusal(event, lines, row),
      closedAt: row ? row.closedAt.toISOString() : null,
      payout:
        row?.payoutReference && row.settledAt
          ? {
              payeeName: row.payeeName ?? '',
              bankDetails: row.payeeBankDetails ?? '',
              reference: row.payoutReference,
              settledAt: row.settledAt.toISOString(),
            }
          : null,
      settledAt: row?.settledAt ? row.settledAt.toISOString() : null,
      payments: lines,
    };
  }

  /** open → closing (or → settled when nothing is owed, ruling 3). Freezes the figures. */
  async close(access: OrgAccessContext, eventId: string, actor: Actor): Promise<SettlementView> {
    await this.dataSource.transaction(async (em) => {
      // Write lock: a staff refund takes the event shared, so none starts while figures freeze.
      const event = await this.events.eventFor(em, access, eventId, true);
      SettlementsService.assertSettles(event);
      const repo = em.getRepository(SettlementEntity);
      if (await repo.existsBy({ eventId: event.id })) {
        throw new ConflictException(`The settlement of ${event.name} is already closed.`);
      }
      const lines = await this.lines(em, event);
      const refusal = SettlementsService.closeRefusal(event, lines, null);
      if (refusal) throw new ConflictException(refusal);
      const figures = settlementFigures(lines, access.organisation.platformFeePercent);
      const now = new Date();
      const nothingToPay = figures.netPayablePaise <= 0;
      await repo.save(
        repo.create({
          organisationId: event.organisationId,
          eventId: event.id,
          status: nothingToPay ? 'settled' : 'closing',
          ...figures,
          closedAt: now,
          closedById: actor.id,
          settledAt: nothingToPay ? now : null,
          settledById: nothingToPay ? actor.id : null,
        }),
      );
      await this.audit.record(
        {
          action: 'settlement.closed',
          actor,
          organisationId: event.organisationId,
          targetType: 'event',
          targetId: event.id,
          metadata: { event: event.name, payments: lines.length, ...figures, nothingToPay },
        },
        em,
      );
    });
    return this.get(access, eventId);
  }

  /** closing → settled: the bank transfer to the payee, recorded by hand (Q10). */
  async payout(
    access: OrgAccessContext,
    eventId: string,
    dto: PayoutDto,
    actor: Actor,
  ): Promise<SettlementView> {
    await this.dataSource.transaction(async (em) => {
      const event = await this.events.eventFor(em, access, eventId, true);
      SettlementsService.assertSettles(event);
      const repo = em.getRepository(SettlementEntity);
      const row = await repo.findOne({
        where: { eventId: event.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) {
        throw new ConflictException(
          `Close the settlement of ${event.name} before recording its payout.`,
        );
      }
      if (row.status !== 'closing') {
        throw new ConflictException(`The settlement of ${event.name} is already settled.`);
      }
      Object.assign(row, {
        status: 'settled',
        payeeName: dto.payeeName,
        payeeBankDetails: dto.bankDetails,
        payoutReference: dto.reference,
        settledAt: new Date(),
        settledById: actor.id,
      });
      await repo.save(row);
      // Bank details stay off the audit log (ruling 7).
      await this.audit.record(
        {
          action: 'settlement.paid_out',
          actor,
          organisationId: event.organisationId,
          targetType: 'event',
          targetId: event.id,
          metadata: {
            event: event.name,
            netPayablePaise: row.netPayablePaise,
            payee: dto.payeeName,
            reference: dto.reference,
          },
        },
        em,
      );
    });
    return this.get(access, eventId);
  }

  /** The event's captured payments with what was refunded and what is still on the way. */
  private async lines(em: EntityManager, event: EventEntity): Promise<SettlementPaymentView[]> {
    const rows: Array<Record<string, string | number | Date | null>> = await em.query(
      `SELECT p.id, p.booking_id, b.stall_label, x.name AS exhibitor_name, p.status, p.method,
              p.paid_at, p.amount_paise, p.fee_paise,
              COALESCE(sum(r.amount_paise) FILTER (WHERE r.status = 'processed'), 0) AS refunded,
              COALESCE(sum(r.amount_paise) FILTER (WHERE r.status IN ('requested', 'sending')), 0)
                AS pending
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
         JOIN exhibitors x ON x.id = b.exhibitor_id
         LEFT JOIN refunds r ON r.payment_id = p.id
        WHERE b.event_id = $1 AND p.organisation_id = $2
          AND p.status IN ('paid', 'partially_refunded', 'refunded')
        GROUP BY p.id, b.stall_label, x.name
        ORDER BY p.paid_at, p.id`,
      [event.id, event.organisationId],
    );
    // bigint and timestamptz come back as text / Date from the driver; map with Number() and toISOString().
    return rows.map((row) => ({
      id: String(row.id),
      bookingId: String(row.booking_id),
      stallLabel: String(row.stall_label),
      exhibitorName: String(row.exhibitor_name),
      status: row.status as PaymentStatus,
      method: row.method === null ? null : String(row.method),
      paidAt: new Date(row.paid_at as string | Date).toISOString(),
      amountPaise: Number(row.amount_paise),
      feePaise: row.fee_paise === null ? null : Number(row.fee_paise),
      refundedPaise: Number(row.refunded),
      pendingRefundPaise: Number(row.pending),
    }));
  }

  static closeRefusal(
    event: EventEntity,
    lines: readonly PaymentLine[],
    row: SettlementEntity | null,
  ): string | null {
    if (row) return null;
    if (event.status !== 'completed') {
      return `The settlement of ${event.name} closes once the event is completed; it is ${event.status}.`;
    }
    const pending = lines.filter((l) => l.pendingRefundPaise > 0).length;
    if (pending) {
      return `${event.name} has ${pending} ${pending === 1 ? 'payment' : 'payments'} with a refund still on the way. Close the settlement once they are through (a few minutes).`;
    }
    return null;
  }

  /** Only events sold on the platform's portal have money of ours to settle. */
  private static assertSettles(event: EventEntity): void {
    if (event.bookingChannel !== 'platform_portal') {
      throw new ConflictException(
        `Stalls of ${event.name} are sold through the venue’s own system; there is nothing to settle here.`,
      );
    }
  }
}
