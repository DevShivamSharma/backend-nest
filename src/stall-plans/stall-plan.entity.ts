import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { OrganisationEntity } from '../organisations/organisation.entity';
import type { RuleOverride, StallSide } from '../rules/rule-engine';

/**
 * `draft`: being drawn. `approved`: checked against the rules and approved, no longer edited.
 * `published`: sent to booking — only its stalls can be held or booked.
 */
export type StallPlanStatus = 'draft' | 'approved' | 'published';

/** SelfCare's two stall types: a shell scheme stall or bare space. */
export type StallType = 'shell' | 'bare';
export const STALL_TYPES: readonly StallType[] = ['shell', 'bare'];

/** The stalls of one hall of one event, drawn on the floor version the event booked. */
@Entity({ name: 'stall_plans' })
export class StallPlanEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'hall_id', type: 'uuid' })
  hallId!: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: StallPlanStatus;

  /** Goes up on every change, so two editors cannot overwrite each other unseen. */
  @Column({ type: 'integer', default: 1 })
  revision!: number;

  /** Rules set aside for some stalls (or all), each with its reason, as approval shows them. */
  @Column({ name: 'rule_overrides', type: 'jsonb', default: () => "'[]'" })
  ruleOverrides!: RuleOverride[];

  @Column({ name: 'approved_by', type: 'uuid', nullable: true })
  approvedById!: string | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @Column({ name: 'published_by', type: 'uuid', nullable: true })
  publishedById!: string | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => OrganisationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: OrganisationEntity;
}

/** A stall: a rectangle along the floor's axes, metres, top-left origin. */
@Entity({ name: 'stalls' })
export class StallEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'plan_id', type: 'uuid' })
  planId!: string;

  /** Unique within its plan, e.g. "A-12". */
  @Column({ type: 'varchar', length: 40 })
  number!: string;

  @Column({ type: 'double precision' })
  x!: number;

  @Column({ type: 'double precision' })
  y!: number;

  @Column({ type: 'double precision' })
  width!: number;

  @Column({ type: 'double precision' })
  depth!: number;

  @Column({ name: 'open_sides', type: 'text', array: true, default: () => "'{}'::text[]" })
  openSides!: StallSide[];

  @Column({ name: 'stall_type', type: 'varchar', length: 8, nullable: true })
  stallType!: StallType | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => StallPlanEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' })
  plan?: StallPlanEntity;
}
