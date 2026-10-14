import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** How a push to the venue system stands. */
export const PLAN_DELIVERY_STATUSES = ['pending', 'sending', 'delivered', 'failed'] as const;
export type PlanDeliveryStatus = (typeof PLAN_DELIVERY_STATUSES)[number];

/**
 * One push of a hall's published plan to the venue's system (the outbox, docs/15 §4.3). The id
 * is made by the app because it is inside the signed body; `payload` is the exact text sent, so
 * a retry sends the same bytes.
 */
@Entity({ name: 'plan_deliveries' })
export class PlanDeliveryEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'event_hall_id', type: 'uuid' })
  eventHallId!: string;

  @Column({ type: 'varchar', length: 32, default: 'plan.published' })
  kind!: 'plan.published';

  @Column({ name: 'plan_revision', type: 'integer' })
  planRevision!: number;

  /** Null when the pre-checks failed and nothing was built. */
  @Column({ type: 'text', nullable: true })
  payload!: string | null;

  @Column({ type: 'varchar', length: 16 })
  status!: PlanDeliveryStatus;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  /** The retry time while pending; the claim's lease while sending. */
  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ name: 'last_status_code', type: 'integer', nullable: true })
  lastStatusCode!: number | null;

  /** The venue's error `code`, when its answer had one. */
  @Column({ name: 'venue_code', type: 'varchar', length: 64, nullable: true })
  venueCode!: string | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  /** Codes the venue sent with a successful answer, e.g. `HALL_HAS_NO_BASE_LAYOUT`. */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  warnings!: string[];

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  /** The failed delivery this one sends again. */
  @Column({ name: 'resent_from', type: 'uuid', nullable: true })
  resentFromId!: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
