import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { paise } from '../bookings/booking.entity';
import { percent } from '../organisations/organisation.entity';

/** `closing`: figures frozen, payout not yet recorded; `settled`: the payee has been paid (or nothing was owed). */
export const SETTLEMENT_STATUSES = ['closing', 'settled'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/** The frozen figures of a platform-portal event, and the payout that settled them. One per event. */
@Entity({ name: 'settlements' })
export class SettlementEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: SettlementStatus;

  @Column({ name: 'gross_paise', type: 'bigint', transformer: paise })
  grossPaise!: number;

  @Column({ name: 'refunded_paise', type: 'bigint', transformer: paise })
  refundedPaise!: number;

  @Column({ name: 'gateway_fee_paise', type: 'bigint', transformer: paise })
  gatewayFeePaise!: number;

  /** The organisation's fee at the time of closing. */
  @Column({
    name: 'platform_fee_percent',
    type: 'numeric',
    precision: 5,
    scale: 2,
    transformer: percent,
  })
  platformFeePercent!: number;

  @Column({ name: 'platform_fee_paise', type: 'bigint', transformer: paise })
  platformFeePaise!: number;

  /** What is owed to the payee; zero or less means nothing is paid out. */
  @Column({ name: 'net_payable_paise', type: 'bigint', transformer: paise })
  netPayablePaise!: number;

  @Column({ name: 'payee_name', type: 'varchar', length: 160, nullable: true })
  payeeName!: string | null;

  @Column({ name: 'payee_bank_details', type: 'varchar', length: 1000, nullable: true })
  payeeBankDetails!: string | null;

  @Column({ name: 'payout_reference', type: 'varchar', length: 120, nullable: true })
  payoutReference!: string | null;

  @Column({ name: 'closed_at', type: 'timestamptz' })
  closedAt!: Date;

  @Column({ name: 'closed_by', type: 'uuid', nullable: true })
  closedById!: string | null;

  @Column({ name: 'settled_at', type: 'timestamptz', nullable: true })
  settledAt!: Date | null;

  @Column({ name: 'settled_by', type: 'uuid', nullable: true })
  settledById!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
