import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { paise } from '../bookings/booking.entity';

/** `log`: the development transport, with fake orders; `razorpay`: real money. */
export const PAYMENT_PROVIDERS = ['razorpay', 'log'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/**
 * `created` until paid; a failed attempt leaves it `failed` and it can be paid again; an order
 * nobody paid is `expired`. Once money has arrived it is `paid`, then `partially_refunded` or
 * `refunded` as refunds are processed.
 */
export const PAYMENT_STATUSES = [
  'created',
  'paid',
  'failed',
  'expired',
  'refunded',
  'partially_refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
/** An order that can still be paid. */
export const OPEN_PAYMENT_STATUSES: readonly PaymentStatus[] = ['created', 'failed'];
/** Money has arrived (and maybe partly or wholly gone back). */
export const SETTLED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'paid',
  'refunded',
  'partially_refunded',
];

/**
 * `requested` until sent; `sending` once marked, before the gateway is called (and never resent
 * on its own, since the gateway may already have it); then `processed` or `failed`.
 */
export const REFUND_STATUSES = ['requested', 'sending', 'processed', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** One order for a booking's amount, and what became of it. */
@Entity({ name: 'payments' })
export class PaymentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId!: string;

  @Column({ type: 'varchar', length: 16 })
  provider!: PaymentProvider;

  @Column({ name: 'provider_order_id', type: 'varchar', length: 64 })
  providerOrderId!: string;

  @Column({ name: 'provider_payment_id', type: 'varchar', length: 64, nullable: true })
  providerPaymentId!: string | null;

  @Column({ name: 'amount_paise', type: 'bigint', transformer: paise })
  amountPaise!: number;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: PaymentStatus;

  @Column({ type: 'varchar', length: 32, nullable: true })
  method!: string | null;

  @Column({ name: 'fee_paise', type: 'bigint', nullable: true, transformer: paise })
  feePaise!: number | null;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  /** The gateway's payment as last reported, for support; never read back as truth. */
  @Column({ type: 'jsonb', nullable: true })
  raw!: Record<string, unknown> | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

/** One webhook delivery, by the gateway's event id: a redelivery finds its row and stops. */
@Entity({ name: 'payment_events' })
export class PaymentEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16 })
  provider!: 'razorpay';

  @Column({ name: 'provider_event_id', type: 'varchar', length: 80 })
  providerEventId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 48 })
  eventType!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** What was done with it, e.g. "applied" or "ignored". */
  @Column({ type: 'varchar', length: 32 })
  outcome!: string;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;
}

/** A request to give some or all of a payment back. */
@Entity({ name: 'refunds' })
export class RefundEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'payment_id', type: 'uuid' })
  paymentId!: string;

  @Column({ name: 'amount_paise', type: 'bigint', transformer: paise })
  amountPaise!: number;

  @Column({ name: 'provider_refund_id', type: 'varchar', length: 64, nullable: true })
  providerRefundId!: string | null;

  @Column({ type: 'varchar', length: 16 })
  status!: RefundStatus;

  @Column({ type: 'varchar', length: 500 })
  reason!: string;

  /** Why the gateway refused it; only on a `failed` refund. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  failure!: string | null;

  @Column({ name: 'requested_by', type: 'uuid', nullable: true })
  requestedById!: string | null;

  @CreateDateColumn({ name: 'requested_at', type: 'timestamptz' })
  requestedAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
