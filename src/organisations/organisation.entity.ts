import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import {
  BookingMode,
  OrganisationConfig,
  OrganisationFeatures,
  OrganisationLimits,
} from './organisation-config';

export enum OrganisationStatus {
  Active = 'active',
  Suspended = 'suspended',
}

/** Postgres numeric comes back as text; a percent is used as a number. */
export const percent = {
  to: (v: number | null) => v,
  from: (v: string | null) => (v === null ? null : Number(v)),
};

/** A tenant: one exhibition-centre operator (ITPO, Yashobhoomi, Jio World Convention Centre). */
@Entity({ name: 'organisations' })
export class OrganisationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** First path segment of every URL of the organisation. Renaming keeps the old one as alias. */
  @Column({ type: 'varchar', length: 40, unique: true })
  slug!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @Column({ type: 'varchar', length: 16, default: OrganisationStatus.Active })
  status!: OrganisationStatus;

  @Column({ name: 'suspended_reason', type: 'varchar', length: 500, nullable: true })
  suspendedReason!: string | null;

  @Column({ name: 'booking_mode', type: 'varchar', length: 16, default: BookingMode.OwnPortal })
  bookingMode!: BookingMode;

  /** The platform's fee on what an event kept after refunds, set by the Super Admin (docs/15 Q9). */
  @Column({
    name: 'platform_fee_percent',
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
    transformer: percent,
  })
  platformFeePercent!: number;

  @Column({ type: 'jsonb' })
  features!: OrganisationFeatures;

  @Column({ type: 'jsonb' })
  limits!: OrganisationLimits;

  /** The current configuration; every version, this one included, is in the history table. */
  @Column({ type: 'jsonb' })
  config!: OrganisationConfig;

  @Column({ name: 'config_version', type: 'integer', default: 1 })
  configVersion!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
