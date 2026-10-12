import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In, IsNull, QueryFailedError } from 'typeorm';

import { MembershipsService } from '../access/memberships.service';
import { AuditService } from '../audit/audit.service';
import { eventClosedReason, isActive, portalClosedReason } from '../bookings/booking-rules';
import { BookingEntity } from '../bookings/booking.entity';
import { BookingsService } from '../bookings/bookings.service';
import type { Actor, AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import type { PaymentsConfig } from '../config/configuration';
import { EventEntity, EventHallEntity } from '../events/event.entity';
import { EventsService } from '../events/events.service';
import { ExhibitorEntity } from '../exhibitors/exhibitor.entity';
import { MailMessage, MailService } from '../mail/mail.service';
import { OrganisationEntity } from '../organisations/organisation.entity';
import type { CheckoutView, PaymentResultView } from '../portal/portal.views';
import { RoleScopeKind } from '../roles/role.entity';
import { RolesService } from '../roles/roles.service';
import { expireOpenPayments } from './booking-payments';
import { RefundDto, VerifyPaymentDto } from './dto/payment.dto';
import { paymentReceiptEmail, paymentRefundedEmail } from './payment-email';
import {
  type CapturedPayment,
  GatewayError,
  type GatewayRefund,
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from './payment-gateway';
import { checkoutSignatureValid } from './payment-signature';
import {
  OPEN_PAYMENT_STATUSES,
  PaymentEntity,
  type PaymentStatus,
  RefundEntity,
  SETTLED_PAYMENT_STATUSES,
} from './payment.entity';
import {
  type RazorpayPaymentEntity,
  type RazorpayRefundEntity,
  type RazorpayWebhook,
  toGatewayPayment,
} from './razorpay-gateway';

/** Work that waits for the commit: refunds to send, emails to post. */
export interface AfterCommit {
  refundIds: string[];
  mails: MailMessage[];
}
export type PaidOutcome =
  'confirmed' | 'revived' | 'already_paid' | 'refunding' | 'unknown_order' | 'amount_mismatch';

/** How many requested refunds one worker tick sends. */
const REFUND_BATCH = 20;
/** How many orders, and how many refunds, one reconcile pass asks the gateway about. */
const RECONCILE_BATCH = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Payments for portal holds on the platform's Razorpay account (docs/15 §6). An order is made for
 * a held booking; Checkout's verify, Razorpay's webhook, the reconcile pass (for a webhook that
 * never came) and the development route all settle a captured payment through `markPaid`, which
 * confirms the booking or, when it no longer can be, requests a full refund. Refunds are rows
 * first: each is marked `sending` and committed before the gateway is called, outside any lock,
 * and settled in a transaction of its own afterwards, so a crash mid-call leaves a `sending` row
 * for staff instead of a second refund.
 *
 * Lock order extends `BookingsService`'s: the event row (shared), the booking row, the payment
 * row, the plan row (shared), the published stall row. Refund rows are locked alone (worker,
 * webhook, reconcile pass), then their payment.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly bookings: BookingsService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly memberships: MembershipsService,
  ) {}

  // ---- orders -------------------------------------------------------------------------------

  /**
   * Checkout's options for a held booking: its open order when there is one at the booking's
   * price (no call to Razorpay), else a new order. Null for a stall priced 0, which staff confirm.
   */
  async openOrder(
    organisation: OrganisationEntity,
    bookingId: string,
    user: AuthUser,
  ): Promise<CheckoutView | null> {
    const booking = await this.dataSource
      .getRepository(BookingEntity)
      .findOneBy({ id: bookingId, organisationId: organisation.id });
    if (!booking) throw new NotFoundException('There is no such booking.');
    PaymentsService.assertPayable(booking);
    if (booking.amountPaise === 0) return null;

    const open = await this.openPayment(this.dataSource.manager, booking.id);
    // The same order serves a retry (ruling 6) while it is for this amount on this gateway.
    if (
      open &&
      open.amountPaise === booking.amountPaise &&
      open.currency === booking.currency &&
      open.provider === this.gateway.provider
    ) {
      return this.checkout(organisation, booking, open, user);
    }

    // Outside any transaction: no lock waits on Razorpay's answer.
    const { orderId } = await this.gatewayCall(
      () =>
        this.gateway.createOrder({
          amountPaise: booking.amountPaise,
          currency: booking.currency,
          receipt: booking.id,
          notes: { orgSlug: organisation.slug, eventId: booking.eventId, bookingId: booking.id },
        }),
      'Razorpay could not start the payment just now. Try again in a moment.',
    );
    try {
      const payment = await this.dataSource.transaction(async (em) => {
        await this.lockEvent(em, booking.eventId);
        const locked = await em.getRepository(BookingEntity).findOneOrFail({
          where: { id: booking.id },
          lock: { mode: 'pessimistic_write' },
        });
        // The booking may have changed while the order was made; the order is then not used.
        PaymentsService.assertPayable(locked);
        if (locked.amountPaise !== booking.amountPaise || locked.currency !== booking.currency) {
          throw new ConflictException('The price of this booking changed. Try again.');
        }
        if (open) {
          // Another amount (or gateway): no longer offered. Should it be paid anyway, markPaid
          // still settles it, and refunds it when the booking's price no longer matches.
          await em.query(
            `UPDATE payments SET status = 'expired', updated_at = now()
              WHERE id = $1 AND status IN ('created', 'failed')`,
            [open.id],
          );
        }
        const repo = em.getRepository(PaymentEntity);
        const created = await repo.save(
          repo.create({
            organisationId: organisation.id,
            bookingId: booking.id,
            provider: this.gateway.provider,
            providerOrderId: orderId,
            providerPaymentId: null,
            amountPaise: booking.amountPaise,
            currency: booking.currency,
            status: 'created',
            method: null,
            feePaise: null,
            paidAt: null,
            raw: null,
            createdById: user.id,
          }),
        );
        await this.audit.record(
          {
            action: 'payment.ordered',
            actor: user,
            organisationId: organisation.id,
            targetType: 'payment',
            targetId: created.id,
            metadata: { stall: booking.stallLabel, orderId, amountPaise: booking.amountPaise },
          },
          em,
        );
        return created;
      });
      return this.checkout(organisation, booking, payment, user);
    } catch (error) {
      // A racing click made the open order first (one per booking): use it. The order made here
      // is never paid and lapses at Razorpay.
      if (PaymentsService.isUniqueViolation(error)) {
        const winner = await this.openPayment(this.dataSource.manager, booking.id);
        if (winner) return this.checkout(organisation, booking, winner, user);
      }
      throw error;
    }
  }

  // ---- settling a captured payment ------------------------------------------------------------

  /**
   * Settles a captured payment: marks it paid and confirms its booking, or, when the booking can
   * no longer be confirmed, records a full refund for after the commit. Verify, the webhook, the
   * reconcile pass and the dev route all come here, inside their own transaction (docs/15 §8
   * risk 5). Idempotent: the second caller waits on the booking lock, then finds the payment
   * settled and stops.
   */
  async markPaid(
    em: EntityManager,
    paid: CapturedPayment,
    actor: Actor | null,
    after: AfterCommit,
  ): Promise<{ outcome: PaidOutcome; bookingId: string | null }> {
    // A payment made without an order (a payment link, another integration) has none. TypeORM
    // drops an undefined or null where-value, so the lookup below would match any payment.
    if (!paid.orderId) return { outcome: 'unknown_order', bookingId: null };
    const known = await em
      .getRepository(PaymentEntity)
      .findOneBy({ providerOrderId: paid.orderId });
    // Another integration's payment on the same merchant account: nothing of ours to settle.
    if (!known) return { outcome: 'unknown_order', bookingId: null };
    const { eventId } = await em
      .getRepository(BookingEntity)
      .findOneByOrFail({ id: known.bookingId });
    // BookingsService's lock order, the payment right after its booking.
    const event = await em.getRepository(EventEntity).findOneOrFail({
      where: { id: eventId },
      lock: { mode: 'pessimistic_read' },
    });
    const booking = await em.getRepository(BookingEntity).findOneOrFail({
      where: { id: known.bookingId },
      lock: { mode: 'pessimistic_write' },
    });
    const payment = await em.getRepository(PaymentEntity).findOneOrFail({
      where: { id: known.id },
      lock: { mode: 'pessimistic_write' },
    });
    const audit = (
      action: string,
      targetType: string,
      targetId: string,
      metadata: Record<string, unknown>,
    ) =>
      this.audit.record(
        { action, actor, organisationId: payment.organisationId, targetType, targetId, metadata },
        em,
      );
    if (SETTLED_PAYMENT_STATUSES.includes(payment.status)) {
      if (payment.providerPaymentId !== paid.paymentId) {
        // A second capture on an order already paid (the customer paid twice). Ours stays as it
        // is; the extra money is kept in view for staff, who refund it from the dashboard.
        await audit('payment.mismatch', 'payment', payment.id, {
          orderId: paid.orderId,
          paymentId: paid.paymentId,
          settledPaymentId: payment.providerPaymentId,
          capturedPaise: paid.amountPaise,
          currency: paid.currency,
          problem: 'A second payment on an order already paid.',
        });
        this.logger.warn(`A second payment ${paid.paymentId} on paid order ${paid.orderId}.`);
      }
      // Settled before (the webhook, or an earlier verify). It bought the stall only if the
      // booking is confirmed and none of the payment is going back; otherwise the money was
      // refunded or is on its way, and the payer must hear that, not see a receipt.
      const back = (await this.refundedOrOnTheWay(em, [payment.id])).get(payment.id) ?? 0;
      return {
        outcome: booking.status === 'confirmed' && back === 0 ? 'already_paid' : 'refunding',
        bookingId: booking.id,
      };
    }
    if (paid.amountPaise !== payment.amountPaise || paid.currency !== payment.currency) {
      // An order fixes its amount, so this means a gateway fault: keep it for staff, touch nothing.
      await audit('payment.mismatch', 'payment', payment.id, {
        orderId: paid.orderId,
        paymentId: paid.paymentId,
        expectedPaise: payment.amountPaise,
        capturedPaise: paid.amountPaise,
        currency: paid.currency,
      });
      return { outcome: 'amount_mismatch', bookingId: booking.id };
    }
    Object.assign(payment, {
      status: 'paid',
      providerPaymentId: paid.paymentId,
      method: paid.method,
      feePaise: paid.feePaise,
      paidAt: new Date(),
      raw: paid.raw,
    });
    await em.getRepository(PaymentEntity).save(payment);
    await audit('payment.paid', 'payment', payment.id, {
      stall: booking.stallLabel,
      orderId: paid.orderId,
      paymentId: paid.paymentId,
      amountPaise: paid.amountPaise,
      method: paid.method,
    });

    const from = booking.status;
    const refusal = await this.confirmPaid(em, event, booking, payment, actor);
    if (refusal === null) {
      after.mails.push(...(await this.receiptMail(em, booking, payment)));
      return { outcome: from === 'expired' ? 'revived' : 'confirmed', bookingId: booking.id };
    }
    // Money never sits unexplained (§6.2): it goes back, and the exhibitor is told why.
    const refundId = await this.requestRefund(em, payment, payment.amountPaise, refusal, actor);
    after.refundIds.push(refundId);
    after.mails.push(...(await this.autoRefundMail(em, booking, payment, refusal)));
    return { outcome: 'refunding', bookingId: booking.id };
  }

  /**
   * Confirms the booking a payment is for, or says why the money goes back (docs/15 §6.2). A
   * held booking is confirmed even if its time ran out a moment ago: the worker had not expired
   * it, so nobody else could hold the stall. An expired one is revived when the event is still
   * on sale and its stall is still published, for sale, free and at the price paid. A cancelled
   * or already confirmed booking, or one whose price changed since the order, is refunded.
   */
  private async confirmPaid(
    em: EntityManager,
    event: EventEntity,
    booking: BookingEntity,
    payment: PaymentEntity,
    actor: Actor | null,
  ): Promise<string | null> {
    const label = booking.stallLabel;
    if (booking.amountPaise !== payment.amountPaise || booking.currency !== payment.currency) {
      return `The booking of stall ${label} changed price after this payment was started.`;
    }
    if (booking.status === 'confirmed') return `Stall ${label} was already confirmed.`;
    if (booking.status === 'cancelled') {
      return `The booking of stall ${label} was cancelled before the payment arrived.`;
    }
    const closed = eventClosedReason(event);
    if (closed) return closed;
    if (booking.status === 'expired') {
      if (booking.channel === 'external') {
        // A revival is a new hold in all but name, so a portal booking needs what a portal hold
        // needs: the organisation's portal on and the event selling on the platform.
        const organisation = await em
          .getRepository(OrganisationEntity)
          .findOneByOrFail({ id: booking.organisationId });
        const portalClosed = portalClosedReason(organisation, event);
        if (portalClosed) return portalClosed;
      }
      const row = await em.getRepository(EventHallEntity).findOneOrFail({
        where: { id: booking.eventHallId },
        relations: { hall: true },
      });
      try {
        // Plan (shared) then stall (write), after the payment: the documented lock order.
        const stall = await this.bookings.lockFreeStall(em, row, booking.stallId);
        if (stall.pricePaise !== booking.amountPaise || stall.currency !== booking.currency) {
          return `Stall ${label} was repriced after the hold ran out.`;
        }
      } catch (error) {
        // Taken by someone else, gone from the plan, or off sale: the refusal says which.
        if (error instanceof HttpException) return error.message;
        throw error;
      }
    }
    const from = booking.status;
    Object.assign(booking, {
      status: 'confirmed',
      confirmedAt: new Date(),
      confirmedById: actor?.id ?? null,
      holdExpiresAt: null,
    });
    await em.getRepository(BookingEntity).save(booking);
    await this.audit.record(
      {
        action: 'booking.confirmed',
        actor,
        organisationId: booking.organisationId,
        targetType: 'booking',
        targetId: booking.id,
        metadata: {
          event: event.name,
          stall: label,
          from,
          to: 'confirmed',
          via: 'payment',
          paymentId: payment.providerPaymentId,
        },
      },
      em,
    );
    return null;
  }

  /** Razorpay reported a failed attempt. The booking stays held; the exhibitor may try again. */
  private async markFailed(em: EntityManager, p: RazorpayPaymentEntity): Promise<string> {
    // No order id: not one of ours, and an undefined where-value would match any payment.
    if (!p.order_id) return 'unknown_order';
    const payment = await em.getRepository(PaymentEntity).findOne({
      where: { providerOrderId: p.order_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payment) return 'unknown_order';
    // Only an unpaid order: a failure reported late never undoes a payment or an expiry.
    if (payment.status !== 'created') return 'payment.failed_ignored';
    Object.assign(payment, { status: 'failed', raw: p as unknown as Record<string, unknown> });
    await em.getRepository(PaymentEntity).save(payment);
    await this.audit.record(
      {
        action: 'payment.failed',
        actor: null,
        organisationId: payment.organisationId,
        targetType: 'payment',
        targetId: payment.id,
        metadata: { orderId: p.order_id, reason: p.error_description ?? null },
      },
      em,
    );
    return 'payment.failed';
  }

  // ---- verify and dev pay ---------------------------------------------------------------------

  /**
   * Checkout's success handler: the signature proves the browser did not invent the payment id,
   * and the payment is fetched from Razorpay to see it captured. Never trusts the browser alone.
   */
  async verify(
    organisation: OrganisationEntity,
    bookingId: string,
    exhibitorId: string,
    dto: VerifyPaymentDto,
    actor: Actor,
  ): Promise<PaymentResultView['outcome']> {
    const row = await this.dataSource.getRepository(PaymentEntity).findOneBy({
      providerOrderId: dto.razorpay_order_id,
      bookingId,
      organisationId: organisation.id,
    });
    const booking = row
      ? await this.dataSource.getRepository(BookingEntity).findOneBy({ id: row.bookingId })
      : null;
    if (!row || !booking || booking.exhibitorId !== exhibitorId) {
      throw new NotFoundException('There is no such payment.');
    }
    // Read where it is used, never kept in a field.
    const keys = this.config.getOrThrow<PaymentsConfig>('payments').razorpay;
    if (!keys) {
      throw new ConflictException('Payments run in test mode here; use the development payment.');
    }
    if (
      !checkoutSignatureValid(
        dto.razorpay_order_id,
        dto.razorpay_payment_id,
        dto.razorpay_signature,
        keys.keySecret,
      )
    ) {
      throw new BadRequestException('The payment could not be verified.');
    }
    const p = await this.gatewayCall(
      () => this.gateway.fetchPayment(dto.razorpay_payment_id),
      'Razorpay could not be reached to check the payment. Try again in a moment.',
    );
    if (p.orderId !== dto.razorpay_order_id) {
      throw new BadRequestException('The payment could not be verified.');
    }
    // Auto-capture off: the payment.captured webhook finishes it (ruling 7).
    if (p.status === 'authorized') return 'pending';
    if (p.status !== 'captured') {
      const until = booking.holdExpiresAt
        ? booking.holdExpiresAt.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: organisation.config.locale.timezone,
          })
        : null;
      throw new ConflictException(
        until
          ? `The payment did not go through. Your hold lasts until ${until}; try again.`
          : 'The payment did not go through.',
      );
    }
    const after: AfterCommit = { refundIds: [], mails: [] };
    const { outcome } = await this.dataSource.transaction((em) =>
      this.markPaid(em, p, actor, after),
    );
    await this.afterCommit(after);
    if (outcome === 'unknown_order' || outcome === 'amount_mismatch') {
      throw new ConflictException('The payment needs a look from the organiser.');
    }
    return outcome;
  }

  /**
   * The log transport's stand-in for Checkout: pays an order in full (development and e2e). Only
   * someone who could pay it for real may: the exhibitor the booking is for, or staff who manage
   * its bookings. Anyone else is told there is no such order, so order ids reveal nothing.
   */
  async devPay(orderId: string, actor: Actor): Promise<PaidOutcome> {
    if (this.gateway.provider !== 'log') throw new NotFoundException();
    const row = await this.dataSource
      .getRepository(PaymentEntity)
      .findOneBy({ providerOrderId: orderId });
    const booking = row
      ? await this.dataSource.getRepository(BookingEntity).findOneBy({ id: row.bookingId })
      : null;
    if (!row || !booking || !(await this.mayPayFor(actor, booking))) {
      throw new NotFoundException('There is no such order.');
    }
    const after: AfterCommit = { refundIds: [], mails: [] };
    const { outcome } = await this.dataSource.transaction((em) =>
      this.markPaid(
        em,
        {
          orderId,
          paymentId: `pay_log_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
          amountPaise: row.amountPaise,
          currency: row.currency,
          method: 'log',
          feePaise: 0,
          raw: { transport: 'log' },
        },
        actor,
        after,
      ),
    );
    await this.afterCommit(after);
    return outcome;
  }

  /**
   * Whether the user may pay for the booking: a member of its organisation who acts for its
   * exhibitor, or who holds `bookings.manage` (an organiser only for its own events, as on the
   * bookings routes).
   */
  private async mayPayFor(actor: Actor, booking: BookingEntity): Promise<boolean> {
    const membership = await this.memberships.findWithRole(actor.id, booking.organisationId);
    if (!membership?.role) return false;
    const scope = membership.scope ?? {};
    if (scope.exhibitorId && scope.exhibitorId === booking.exhibitorId) return true;
    if (!RolesService.effectivePermissions(membership.role).includes('bookings.manage')) {
      return false;
    }
    return (
      membership.role.scopeKind !== RoleScopeKind.Event ||
      (scope.eventIds ?? []).includes(booking.eventId)
    );
  }

  // ---- webhook --------------------------------------------------------------------------------

  /**
   * One Razorpay webhook delivery. Razorpay delivers at least once, so the event id is stored
   * first under a unique key: a redelivery inserts nothing and stops. The row and the work share
   * one transaction, so a failure rolls both back and Razorpay's retry finds no row and tries
   * again.
   */
  async handleWebhook(eventId: string, body: RazorpayWebhook): Promise<string> {
    const after: AfterCommit = { refundIds: [], mails: [] };
    const outcome = await this.dataSource.transaction(async (em) => {
      const inserted: Array<{ id: string }> = await em.query(
        `INSERT INTO payment_events (provider, provider_event_id, event_type, payload, outcome)
         VALUES ('razorpay', $1, $2, $3, 'received')
         ON CONFLICT (provider_event_id) DO NOTHING
         RETURNING id`,
        [eventId, String(body.event ?? '').slice(0, 48), body],
      );
      if (!inserted.length) return 'duplicate';
      const outcome = await this.applyWebhook(em, body, after);
      await em.query(`UPDATE payment_events SET outcome = $2 WHERE id = $1`, [
        inserted[0].id,
        outcome,
      ]);
      return outcome;
    });
    await this.afterCommit(after);
    return outcome;
  }

  private async applyWebhook(
    em: EntityManager,
    body: RazorpayWebhook,
    after: AfterCommit,
  ): Promise<string> {
    const payment = body.payload?.payment?.entity;
    const refund = body.payload?.refund?.entity;
    switch (body.event) {
      case 'payment.captured':
        if (!payment) return 'malformed';
        return `payment.${(await this.markPaid(em, toGatewayPayment(payment), null, after)).outcome}`;
      case 'payment.failed':
        return payment ? this.markFailed(em, payment) : 'malformed';
      case 'refund.processed':
      case 'refund.failed': {
        if (!refund) return 'malformed';
        const row = await this.refundOfWebhook(em, refund);
        // A refund made in the Razorpay dashboard, not here: kept in payment_events only.
        if (!row) return 'unknown_refund';
        if (body.event === 'refund.processed') await this.refundProcessed(em, row);
        else if (row.status === 'requested' || row.status === 'sending') {
          await this.refundFailed(em, row, 'Razorpay reported the refund as failed.');
        }
        return body.event;
      }
      default:
        return 'ignored';
    }
  }

  // ---- refunds --------------------------------------------------------------------------------

  /**
   * A staff refund of a paid booking, all that is left or part of it. Refunding everything left
   * cancels a held or confirmed booking (ruling 13); a partial refund leaves it as it is. The
   * refund is sent right after the commit; the worker retries one that could not be sent.
   */
  async refundBooking(
    access: OrgAccessContext,
    bookingId: string,
    dto: RefundDto,
    actor: Actor,
  ): Promise<void> {
    const visible = EventsService.visibleIds(access);
    const after: AfterCommit = { refundIds: [], mails: [] };
    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(BookingEntity);
      const found = await repo.findOneBy({ id: bookingId, organisationId: access.organisation.id });
      if (!found || (visible && !visible.includes(found.eventId))) {
        throw new NotFoundException('There is no such booking.');
      }
      const event = await this.lockEvent(em, found.eventId);
      const booking = await repo.findOneOrFail({
        where: { id: bookingId },
        lock: { mode: 'pessimistic_write' },
      });
      const settled = await em.getRepository(PaymentEntity).find({
        where: { bookingId, status: In(['paid', 'partially_refunded']) },
        order: { paidAt: 'DESC' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!settled.length) throw new ConflictException('This booking has no payment to refund.');
      const done = await this.refundedOrOnTheWay(
        em,
        settled.map((p) => p.id),
      );
      const leftOf = (p: PaymentEntity) => p.amountPaise - (done.get(p.id) ?? 0);
      // Usually one payment. A late payment at an old price sits beside it until its own
      // automatic refund goes through, and then has nothing left.
      const payment = settled.find((p) => leftOf(p) > 0);
      if (!payment) {
        throw new ConflictException(
          'Everything paid for this booking is already refunded or on its way back.',
        );
      }
      const left = leftOf(payment);
      const amount = dto.amountPaise ?? left;
      if (amount > left) {
        throw new ConflictException(
          `At most ₹${(left / 100).toLocaleString('en-IN')} can be refunded.`,
        );
      }
      after.refundIds.push(await this.requestRefund(em, payment, amount, dto.reason, actor));
      if (amount === left && isActive(booking.status)) {
        const from = booking.status;
        Object.assign(booking, {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledById: actor.id,
          cancelReason: dto.reason,
        });
        await repo.save(booking);
        // It left `held` or `confirmed`: an open order can no longer confirm it (ruling 5).
        await expireOpenPayments(em, [booking.id]);
        await this.audit.record(
          {
            action: 'booking.cancelled',
            actor,
            organisationId: booking.organisationId,
            targetType: 'booking',
            targetId: booking.id,
            metadata: {
              event: event.name,
              stall: booking.stallLabel,
              from,
              to: 'cancelled',
              reason: dto.reason,
              via: 'refund',
            },
          },
          em,
        );
      }
    });
    await this.afterCommit(after);
  }

  /**
   * Sends one requested refund. Three steps, so no lock is held while Razorpay answers: claim the
   * row (`requested` → `sending`) and commit; call the gateway; settle the row in a new
   * transaction. A row left `sending` is never sent again on its own: the gateway may already
   * have it. Its `refund.processed` webhook (matched by the id in its notes) settles it, or staff
   * do. Errors here are the database's; gateway errors are handled.
   */
  async sendRefund(refundId: string): Promise<void> {
    const claim = await this.dataSource.transaction(async (em) => {
      const [row]: Array<{ id: string }> = await em.query(
        `SELECT id FROM refunds WHERE id = $1 AND status = 'requested' FOR UPDATE SKIP LOCKED`,
        [refundId],
      );
      if (!row) return null; // another instance has it, or it is done
      const refund = await em.getRepository(RefundEntity).findOneByOrFail({ id: refundId });
      const payment = await em
        .getRepository(PaymentEntity)
        .findOneByOrFail({ id: refund.paymentId });
      if (!payment.providerPaymentId) {
        // A settled payment always has one (the payments CHECK); this is only a guard.
        await this.refundFailed(em, refund, 'The payment has no gateway payment id to refund.');
        return null;
      }
      refund.status = 'sending';
      await em.getRepository(RefundEntity).save(refund);
      return { amountPaise: refund.amountPaise, paymentId: payment.providerPaymentId };
    });
    if (!claim) return;

    let sent: GatewayRefund;
    try {
      sent = await this.gateway.refund({
        paymentId: claim.paymentId,
        amountPaise: claim.amountPaise,
        notes: { refundId },
      });
    } catch (error) {
      if (error instanceof GatewayError && error.status === 429) {
        // Rate limited: Razorpay made nothing, so it is safe to send again on the next tick.
        await this.dataSource.query(
          `UPDATE refunds SET status = 'requested', updated_at = now()
            WHERE id = $1 AND status = 'sending' AND provider_refund_id IS NULL`,
          [refundId],
        );
        this.logger.warn(`Refund ${refundId}: Razorpay is rate-limiting; it is sent again later.`);
        return;
      }
      if (error instanceof GatewayError && (error.status === 401 || error.status === 403)) {
        // Razorpay turned our keys away, so it made nothing; the refund itself is not at fault.
        // Back to `requested`: the worker sends it once the keys are put right.
        await this.dataSource.query(
          `UPDATE refunds SET status = 'requested', updated_at = now()
            WHERE id = $1 AND status = 'sending' AND provider_refund_id IS NULL`,
          [refundId],
        );
        this.logger.warn(
          `Refund ${refundId}: Razorpay did not accept the API keys (HTTP ${error.status}); check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET. It is sent again later.`,
        );
        return;
      }
      if (error instanceof GatewayError && error.refused) {
        // Razorpay refused it (e.g. more than is left): nothing was made, so it failed.
        await this.dataSource.transaction(async (em) => {
          const refund = await em.getRepository(RefundEntity).findOne({
            where: { id: refundId },
            lock: { mode: 'pessimistic_write' },
          });
          if (refund?.status === 'sending') await this.refundFailed(em, refund, error.message);
        });
        this.logger.warn(`Refund ${refundId} was refused by Razorpay: ${error.message}`);
        return;
      }
      // No answer, or a server error: Razorpay may have made it. Left `sending` for its webhook
      // or for staff, never resent from here.
      this.logger.error(
        `Refund ${refundId} is left sending; check it in the Razorpay dashboard before anything else: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return;
    }

    await this.dataSource.transaction(async (em) => {
      const refund = await em.getRepository(RefundEntity).findOneOrFail({
        where: { id: refundId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!refund.providerRefundId) {
        refund.providerRefundId = sent.refundId;
        await em.getRepository(RefundEntity).save(refund);
      }
      // The webhook settled it first.
      if (refund.status !== 'sending') return;
      if (sent.status === 'processed') await this.refundProcessed(em, refund);
      else if (sent.status === 'failed') {
        await this.refundFailed(em, refund, 'Razorpay reported the refund as failed.');
      }
      // `pending`: Razorpay has it; its refund.processed webhook finishes it.
    });
  }

  /** The worker's tick: sends requested refunds, oldest first, each on its own. */
  async sendDueRefunds(): Promise<number> {
    const due: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM refunds WHERE status = 'requested' ORDER BY requested_at LIMIT $1`,
      [REFUND_BATCH],
    );
    for (const { id } of due) {
      try {
        await this.sendRefund(id);
      } catch (error) {
        this.logger.error(
          `Could not send refund ${id}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return due.length;
  }

  // ---- reconciling with the gateway -----------------------------------------------------------

  /**
   * Catches up on webhooks that never came. Razorpay is asked about recent unpaid orders and about
   * refunds it has taken but not reported settled, and what it reports is settled through the same
   * paths its webhooks use (`markPaid`, `refundProcessed`, `refundFailed`). Each row is checked on
   * its own and no lock is held while Razorpay answers. A `sending` refund without Razorpay's id
   * is never touched: it may not have reached Razorpay, and sending it again could refund twice.
   * Returns how many payments and refunds it settled.
   */
  async reconcile(): Promise<number> {
    // The log transport's orders are paid only by the development route: nothing to catch up on.
    if (this.gateway.provider === 'log') return 0;
    return (await this.reconcileOrders()) + (await this.reconcileRefunds());
  }

  /**
   * Unpaid orders of the last day, the longest unchecked first. Each one's payments are fetched,
   * and a captured one is settled. `updated_at` doubles as "last checked": touching it sends the
   * order to the back of the queue, so a busy day's orders are all looked at in turn, at most
   * RECONCILE_BATCH a pass. Five minutes' grace leaves a fresh order to Checkout and the webhook.
   */
  private async reconcileOrders(): Promise<number> {
    const due: Array<{ id: string; provider_order_id: string; status: PaymentStatus }> =
      await this.dataSource.query(
        `SELECT id, provider_order_id, status FROM payments
          WHERE provider = $1 AND status IN ('created', 'failed', 'expired')
            AND created_at > now() - interval '24 hours'
            AND updated_at < now() - interval '5 minutes'
          ORDER BY updated_at
          LIMIT $2`,
        [this.gateway.provider, RECONCILE_BATCH],
      );
    let settled = 0;
    for (const row of due) {
      // Refunds and receipts of what was settled, sent even if a later payment fails to settle.
      const after: AfterCommit = { refundIds: [], mails: [] };
      try {
        const captured = (await this.gateway.fetchOrderPayments(row.provider_order_id)).filter(
          (p) => p.status === 'captured' && p.orderId === row.provider_order_id,
        );
        for (const p of captured) {
          const { outcome } = await this.dataSource.transaction((em) =>
            this.markPaid(em, p, null, after),
          );
          settled++;
          this.logger.warn(
            `Order ${row.provider_order_id}: captured payment ${p.paymentId} was never reported; settled as ${outcome}.`,
          );
        }
      } catch (error) {
        if (error instanceof GatewayError && error.status === 429) {
          this.logger.warn('Razorpay is rate-limiting; the reconcile pass stops until next time.');
          return settled;
        }
        this.logger.error(
          `Could not reconcile order ${row.provider_order_id}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
      await this.afterCommit(after);
      // Checked (or failed to be): to the back of the queue, unless it was settled just now.
      await this.dataSource.query(
        `UPDATE payments SET updated_at = now() WHERE id = $1 AND status = $2`,
        [row.id, row.status],
      );
    }
    return settled;
  }

  /**
   * Refunds Razorpay has taken (we hold its id) but whose result never arrived: each one is
   * fetched and, once processed or failed, settled as its webhook would. Still pending at Razorpay
   * (refunds can take days): to the back of the queue, as with orders.
   */
  private async reconcileRefunds(): Promise<number> {
    const due: Array<{ id: string; provider_refund_id: string }> = await this.dataSource.query(
      `SELECT r.id, r.provider_refund_id
         FROM refunds r JOIN payments p ON p.id = r.payment_id
        WHERE r.status = 'sending' AND r.provider_refund_id IS NOT NULL AND p.provider = $1
          AND r.updated_at < now() - interval '5 minutes'
        ORDER BY r.updated_at
        LIMIT $2`,
      [this.gateway.provider, RECONCILE_BATCH],
    );
    let settled = 0;
    for (const row of due) {
      try {
        const found = await this.gateway.fetchRefund(row.provider_refund_id);
        const done = await this.dataSource.transaction(async (em) => {
          const refund = await em.getRepository(RefundEntity).findOne({
            where: { id: row.id },
            lock: { mode: 'pessimistic_write' },
          });
          // Settled meanwhile, by its webhook or another instance.
          if (refund?.status !== 'sending') return false;
          if (found.status === 'processed') {
            await this.refundProcessed(em, refund);
            return true;
          }
          if (found.status === 'failed') {
            await this.refundFailed(em, refund, 'Razorpay reported the refund as failed.');
            return true;
          }
          await em.query(`UPDATE refunds SET updated_at = now() WHERE id = $1`, [refund.id]);
          return false;
        });
        if (done) settled++;
      } catch (error) {
        if (error instanceof GatewayError && error.status === 429) {
          this.logger.warn('Razorpay is rate-limiting; the reconcile pass stops until next time.');
          return settled;
        }
        this.logger.error(
          `Could not reconcile refund ${row.id}: ${error instanceof Error ? error.message : error}`,
        );
        // Not lost: it stays `sending` with Razorpay's id, and goes to the back of the queue.
        await this.dataSource.query(`UPDATE refunds SET updated_at = now() WHERE id = $1`, [
          row.id,
        ]);
      }
    }
    return settled;
  }

  /** Records a refund to send after the commit; audited with the transaction. */
  private async requestRefund(
    em: EntityManager,
    payment: PaymentEntity,
    amountPaise: number,
    reason: string,
    actor: Actor | null,
  ): Promise<string> {
    const repo = em.getRepository(RefundEntity);
    const refund = await repo.save(
      repo.create({
        organisationId: payment.organisationId,
        paymentId: payment.id,
        amountPaise,
        providerRefundId: null,
        status: 'requested',
        reason: reason.slice(0, 500),
        failure: null,
        requestedById: actor?.id ?? null,
        processedAt: null,
      }),
    );
    await this.audit.record(
      {
        action: 'refund.requested',
        actor,
        organisationId: payment.organisationId,
        targetType: 'refund',
        targetId: refund.id,
        metadata: { paymentId: payment.providerPaymentId, amountPaise, reason },
      },
      em,
    );
    return refund.id;
  }

  /** The money went back: the refund is processed and its payment (partly) refunded. */
  private async refundProcessed(em: EntityManager, refund: RefundEntity): Promise<void> {
    if (refund.status !== 'requested' && refund.status !== 'sending') return;
    Object.assign(refund, { status: 'processed', processedAt: new Date() });
    await em.getRepository(RefundEntity).save(refund);
    await em.query(
      `UPDATE payments p
          SET status = CASE WHEN s.done >= p.amount_paise THEN 'refunded' ELSE 'partially_refunded' END,
              updated_at = now()
         FROM (SELECT COALESCE(sum(amount_paise), 0) AS done
                 FROM refunds WHERE payment_id = $1 AND status = 'processed') s
        WHERE p.id = $1`,
      [refund.paymentId],
    );
    const payment = await em.getRepository(PaymentEntity).findOneByOrFail({ id: refund.paymentId });
    await this.audit.record(
      {
        action: 'refund.processed',
        actor: null,
        organisationId: refund.organisationId,
        targetType: 'refund',
        targetId: refund.id,
        metadata: { paymentId: payment.providerPaymentId, amountPaise: refund.amountPaise },
      },
      em,
    );
  }

  /** The gateway refused or failed it; the amount counts as refundable again. */
  private async refundFailed(
    em: EntityManager,
    refund: RefundEntity,
    failure: string,
  ): Promise<void> {
    Object.assign(refund, { status: 'failed', failure: failure.slice(0, 300) });
    await em.getRepository(RefundEntity).save(refund);
    const payment = await em.getRepository(PaymentEntity).findOneByOrFail({ id: refund.paymentId });
    await this.audit.record(
      {
        action: 'refund.failed',
        actor: null,
        organisationId: refund.organisationId,
        targetType: 'refund',
        targetId: refund.id,
        metadata: {
          paymentId: payment.providerPaymentId,
          amountPaise: refund.amountPaise,
          failure: refund.failure,
        },
      },
      em,
    );
  }

  /**
   * Our refund row a webhook names by the id in its notes, when its gateway id is not stored
   * yet: locked, checked against the payment it refunds, and given that id.
   */
  private async adoptRefund(
    em: EntityManager,
    refundId: string,
    providerRefundId: string,
    providerPaymentId: string,
  ): Promise<RefundEntity | null> {
    const repo = em.getRepository(RefundEntity);
    const row = await repo.findOne({
      where: { id: refundId, providerRefundId: IsNull() },
      lock: { mode: 'pessimistic_write' },
    });
    if (!row) return null;
    const payment = await em.getRepository(PaymentEntity).findOneByOrFail({ id: row.paymentId });
    if (payment.providerPaymentId !== providerPaymentId) return null;
    row.providerRefundId = providerRefundId;
    return repo.save(row);
  }

  /** Our refund row a refund webhook is about, locked: by its gateway id, else by the id in its notes. */
  private async refundOfWebhook(
    em: EntityManager,
    refund: RazorpayRefundEntity,
  ): Promise<RefundEntity | null> {
    // Without an id the lookup below would match any refund (TypeORM drops undefined values).
    if (!refund.id) return null;
    const row = await em.getRepository(RefundEntity).findOne({
      where: { providerRefundId: refund.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (row) return row;
    // Sent, but its id not yet stored (the call's answer was lost, or this webhook won the
    // race): our row's id travels in the refund's notes.
    const ours = refund.notes?.refundId;
    if (typeof ours === 'string' && UUID.test(ours)) {
      return this.adoptRefund(em, ours, refund.id, refund.payment_id);
    }
    return null;
  }

  /** Per payment, what is refunded or on its way back (a failed refund gives nothing back). */
  private async refundedOrOnTheWay(
    em: EntityManager,
    paymentIds: string[],
  ): Promise<Map<string, number>> {
    const rows: Array<{ payment_id: string; done: string }> = await em.query(
      `SELECT payment_id, sum(amount_paise) AS done
         FROM refunds
        WHERE payment_id = ANY($1::uuid[]) AND status <> 'failed'
        GROUP BY payment_id`,
      [paymentIds],
    );
    return new Map(rows.map((r) => [r.payment_id, Number(r.done)]));
  }

  // ---- emails ---------------------------------------------------------------------------------

  /** The exhibitor's receipt; none when the exhibitor has no email (ruling 10). */
  private async receiptMail(
    em: EntityManager,
    booking: BookingEntity,
    payment: PaymentEntity,
  ): Promise<MailMessage[]> {
    const context = await this.mailContext(em, booking);
    if (!context) return [];
    return [
      paymentReceiptEmail({
        ...context,
        stallLabel: booking.stallLabel,
        amountPaise: payment.amountPaise,
        currency: payment.currency,
        reckoning: booking.priceReckoning,
        paymentId: payment.providerPaymentId ?? payment.providerOrderId,
        paidAt: payment.paidAt ?? new Date(),
      }),
    ];
  }

  /** Tells the exhibitor why their payment goes back; none without an email (ruling 10). */
  private async autoRefundMail(
    em: EntityManager,
    booking: BookingEntity,
    payment: PaymentEntity,
    reason: string,
  ): Promise<MailMessage[]> {
    const context = await this.mailContext(em, booking);
    if (!context) return [];
    return [
      paymentRefundedEmail({
        ...context,
        stallLabel: booking.stallLabel,
        amountPaise: payment.amountPaise,
        currency: payment.currency,
        paymentId: payment.providerPaymentId ?? payment.providerOrderId,
        reason,
      }),
    ];
  }

  private async mailContext(
    em: EntityManager,
    booking: BookingEntity,
  ): Promise<{
    to: string;
    organisation: OrganisationEntity;
    eventName: string;
    link: string;
  } | null> {
    const exhibitor = await em
      .getRepository(ExhibitorEntity)
      .findOneBy({ id: booking.exhibitorId });
    if (!exhibitor?.email) return null;
    const organisation = await em
      .getRepository(OrganisationEntity)
      .findOneByOrFail({ id: booking.organisationId });
    const event = await em.getRepository(EventEntity).findOneByOrFail({ id: booking.eventId });
    return {
      to: exhibitor.email,
      organisation,
      eventName: event.name,
      link: this.mail.link(`/${organisation.slug}/portal/bookings`),
    };
  }

  // ---- helpers --------------------------------------------------------------------------------

  /** Refunds to send and emails to post once the change is stored; failures are logged only. */
  private async afterCommit(after: AfterCommit): Promise<void> {
    for (const id of after.refundIds) {
      try {
        await this.sendRefund(id);
      } catch (error) {
        // The row is still `requested` (or settled by its webhook): the worker tries again.
        this.logger.error(
          `Could not send refund ${id}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    for (const message of after.mails) await this.notify(message);
  }

  /** Sends after the change is stored: a mail server that fails does not undo the payment. */
  private async notify(message: MailMessage): Promise<void> {
    try {
      await this.mail.send(message);
    } catch (error) {
      this.logger.error(
        `Could not send "${message.subject}": ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** Checkout's options for an order of a held booking. */
  private async checkout(
    organisation: OrganisationEntity,
    booking: BookingEntity,
    payment: PaymentEntity,
    user: AuthUser,
  ): Promise<CheckoutView> {
    const exhibitor = await this.dataSource
      .getRepository(ExhibitorEntity)
      .findOneBy({ id: booking.exhibitorId });
    return {
      keyId: this.gateway.keyId,
      orderId: payment.providerOrderId,
      amount: payment.amountPaise,
      currency: payment.currency,
      name: organisation.name,
      description: `Stall ${booking.stallLabel}, excl. GST`,
      prefill: {
        name: exhibitor?.contactName ?? user.name,
        email: exhibitor?.email ?? user.email,
        contact: exhibitor?.phone ?? '',
      },
      holdExpiresAt: booking.holdExpiresAt!.toISOString(),
    };
  }

  /** The booking's order that can still be paid; at most one (a partial unique index). */
  private openPayment(em: EntityManager, bookingId: string): Promise<PaymentEntity | null> {
    return em
      .getRepository(PaymentEntity)
      .findOneBy({ bookingId, status: In([...OPEN_PAYMENT_STATUSES]) });
  }

  /** The event row, share-locked, as `BookingsService` takes it. */
  private lockEvent(em: EntityManager, eventId: string): Promise<EventEntity> {
    return em
      .getRepository(EventEntity)
      .findOneOrFail({ where: { id: eventId }, lock: { mode: 'pessimistic_read' } });
  }

  /** Only a held booking whose time has not run out is paid for. */
  private static assertPayable(booking: BookingEntity): void {
    if (booking.status !== 'held') {
      throw new ConflictException(
        `Only a held booking is paid for; this one is ${booking.status}.`,
      );
    }
    if (!booking.holdExpiresAt || booking.holdExpiresAt <= new Date()) {
      throw new ConflictException('The hold has run out. Hold the stall again.');
    }
  }

  /** A gateway call answered for the browser: a gateway fault becomes a 502 in words. */
  private async gatewayCall<T>(call: () => Promise<T>, message: string): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      this.logger.warn(`Razorpay call failed: ${error.message}`);
      throw new BadGatewayException(message);
    }
  }

  private static isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string } | undefined)?.code === '23505'
    );
  }
}
