import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * `internal`: made by staff with `bookings.manage`, for a registered exhibitor. `external`: held
 * by the exhibitor's own people through the portal (M5).
 */
export const BOOKING_CHANNELS = ['internal', 'external'] as const;
export type BookingChannel = (typeof BOOKING_CHANNELS)[number];

/**
 * `held` until confirmed, or until `hold_expires_at` passes (then `expired`); `confirmed`; either
 * may be `cancelled`. Held and confirmed are active: a stall has at most one active booking.
 */
export const BOOKING_STATUSES = ['held', 'confirmed', 'cancelled', 'expired'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = ['held', 'confirmed'];

/** Postgres bigint may come back as text; paise are used as numbers. A null stays null. */
export const paise = {
  to: (v: number | null) => v,
  from: (v: string | number | null) => (v === null ? null : Number(v)),
};

/** A stall of an event's published plan, held or booked for an exhibitor. */
@Entity({ name: 'bookings' })
export class BookingEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'event_hall_id', type: 'uuid' })
  eventHallId!: string;

  /** The planner's stall id: with the event hall, the key of `published_stalls`. */
  @Column({ name: 'stall_id', type: 'uuid' })
  stallId!: string;

  /** The stall's number when booked, e.g. "B-12", so the record reads after the plan moves on. */
  @Column({ name: 'stall_label', type: 'varchar', length: 60 })
  stallLabel!: string;

  @Column({ name: 'exhibitor_id', type: 'uuid' })
  exhibitorId!: string;

  @Column({ type: 'varchar', length: 16 })
  channel!: BookingChannel;

  @Column({ type: 'varchar', length: 16 })
  status!: BookingStatus;

  /** While held: when the hold runs out unless confirmed. Null once confirmed. */
  @Column({ name: 'hold_expires_at', type: 'timestamptz', nullable: true })
  holdExpiresAt!: Date | null;

  /** The stall's published price when booked: a later rate card never changes what was agreed. */
  @Column({ name: 'amount_paise', type: 'bigint', transformer: paise })
  amountPaise!: number;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ name: 'price_reckoning', type: 'varchar', length: 400 })
  priceReckoning!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdById!: string | null;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  @Column({ name: 'confirmed_by', type: 'uuid', nullable: true })
  confirmedById!: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: 'cancelled_by', type: 'uuid', nullable: true })
  cancelledById!: string | null;

  @Column({ name: 'cancel_reason', type: 'varchar', length: 500, nullable: true })
  cancelReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
