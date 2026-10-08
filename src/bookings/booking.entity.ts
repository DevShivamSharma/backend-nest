import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { ExhibitorEntity } from '../exhibitors/exhibitor.entity';
import { OrganisationEntity } from '../organisations/organisation.entity';
import { StallEntity } from '../stall-plans/stall-plan.entity';

/**
 * `internal`: booked by a member who manages bookings, for an exhibitor. `external`: held by
 * the exhibitor's own user through the portal.
 */
export type BookingChannel = 'internal' | 'external';

/**
 * SelfCare's states, in our words: `held` is its `Pending` / `In-Progress`, `confirmed` its
 * `Confirmed` / `Booked`, `expired` its `Timeout`. Held and confirmed bookings are active: a
 * stall has at most one.
 */
export type BookingStatus = 'held' | 'confirmed' | 'cancelled' | 'expired';
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = ['held', 'confirmed'];

/**
 * Payment as the venue's own booking system reports it (`hybrid_hold`). Null: not tracked here —
 * this platform takes no payment.
 */
export type PaymentStatus = 'pending' | 'completed' | 'timeout' | 'cancelled';

@Entity({ name: 'bookings' })
export class BookingEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'stall_id', type: 'uuid' })
  stallId!: string;

  @Column({ name: 'exhibitor_id', type: 'uuid' })
  exhibitorId!: string;

  @Column({ type: 'varchar', length: 16 })
  channel!: BookingChannel;

  @Column({ type: 'varchar', length: 16 })
  status!: BookingStatus;

  @Column({ name: 'payment_status', type: 'varchar', length: 16, nullable: true })
  paymentStatus!: PaymentStatus | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  /** The venue system's reference for this booking, once it reported one. */
  @Column({ name: 'external_ref', type: 'varchar', length: 80, nullable: true })
  externalRef!: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdById!: string | null;

  @Column({ name: 'confirmed_by', type: 'uuid', nullable: true })
  confirmedById!: string | null;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  @Column({ name: 'cancelled_by', type: 'uuid', nullable: true })
  cancelledById!: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: 'cancel_reason', type: 'varchar', length: 500, nullable: true })
  cancelReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => OrganisationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: OrganisationEntity;

  @ManyToOne(() => StallEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'stall_id' })
  stall?: StallEntity;

  @ManyToOne(() => ExhibitorEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'exhibitor_id' })
  exhibitor?: ExhibitorEntity;
}

/** One status report from a venue's booking system, kept so a repeated delivery does nothing. */
@Entity({ name: 'booking_status_deliveries' })
export class BookingStatusDeliveryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'delivery_id', type: 'varchar', length: 100 })
  deliveryId!: string;

  @Column({ name: 'booking_id', type: 'uuid', nullable: true })
  bookingId!: string | null;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** What the report did, e.g. `confirmed`, `ignored:not_held`. */
  @Column({ type: 'varchar', length: 32 })
  outcome!: string;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;
}
