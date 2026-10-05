import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Table `layouts` (Layout.java).
 *
 * Relations are deliberately NOT modelled with TypeORM relation decorators. The Java relied on
 * JPA cascade + orphanRemoval; here LayoutRepository performs the same inserts and deletes
 * explicitly inside one transaction, so the behaviour is readable in one place instead of being
 * implied by ORM configuration. The foreign keys themselves live in the migration.
 */
@Entity({ name: 'layouts' })
export class LayoutEntity {
  @Column({ name: 'pricing_policy', type: 'jsonb', nullable: true })
  pricingPolicy!: import('../../pricing/pricing-policy').PricingSnapshot | null;

  @Column({ type: 'varchar', length: 16, default: 'DRAFT' })
  status!: 'DRAFT' | 'PUBLISHED';

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ name: 'publish_overrides', type: 'jsonb', nullable: true })
  publishOverrides!: { reason: string; issues: import('../placement/publish-check').PublishIssue[] } | null;
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'BY DEFAULT' })
  id!: number;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ name: 'hall_width', type: 'double precision' })
  hallWidth!: number;

  @Column({ name: 'hall_length', type: 'double precision' })
  hallLength!: number;

  /** Always 0 — see docs/04-business-rules.md BR-15. */
  @Column({ name: 'hall_height', type: 'double precision' })
  hallHeight!: number;

  @Column({ name: 'hall_id', type: 'bigint', nullable: true })
  hallId!: number | null;

  /** B2B or B2C: selects the minimum passage width (ITPO D1). */
  @Column({ name: 'event_type', type: 'varchar', length: 8, default: 'B2B' })
  eventType!: string;

  /**
   * Next stall number to hand out. Only ever increases, so a cancelled or removed stall's
   * number is never given to another stall.
   */
  @Column({ name: 'next_stall_seq', type: 'integer', default: 1 })
  nextStallSeq!: number;

  /** Plotting rules (planner_rules ids) chosen for this layout's design. NULL = none chosen. */
  @Column({ name: 'rule_ids', type: 'jsonb', nullable: true })
  ruleIds!: number[] | null;
}
