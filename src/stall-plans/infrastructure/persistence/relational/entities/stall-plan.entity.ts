import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

import { EntityRelationalHelper } from '../../../../../utils/relational-entity-helper';

/**
 * The stall plan of an event hall, as a draft: what the planner saves, before it is published to
 * ITPO's T_STALLS. One row per event hall (T_EVENT_HALL.id, ITPO's table, so no foreign key).
 *
 * `content` holds the zones, stalls, seats and drawings; `revision` counts the saves, and is what
 * a save or publish must name, so two people cannot overwrite each other. The `review_*` columns
 * are the approval of an external event's plan (submitted, approved, rejected); the `published_*`
 * ones say which revision was last written to T_STALLS.
 */
@Entity({ name: 'T_STALL_PLAN', schema: 'idp' })
@Check(`"review_status" IN ('submitted', 'approved', 'rejected')`)
export class StallPlanEntity extends EntityRelationalHelper {
  @PrimaryColumn({ name: 'event_hall_id', type: 'uuid' })
  eventHallId: string;

  @Column({ type: 'integer', default: 0 })
  revision: number;

  @Column({
    type: 'jsonb',
    default: () => `'{"zones":[],"stalls":[],"seats":[],"objects":[]}'::jsonb`,
  })
  content: Record<string, unknown>;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy: string | null;

  @Column({ name: 'review_status', type: 'varchar', length: 16, nullable: true })
  reviewStatus: 'submitted' | 'approved' | 'rejected' | null;

  @Column({ name: 'review_revision', type: 'integer', nullable: true })
  reviewRevision: number | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ name: 'submitted_by', type: 'uuid', nullable: true })
  submittedBy: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @Column({ name: 'review_note', type: 'varchar', length: 1000, nullable: true })
  reviewNote: string | null;

  @Column({ name: 'published_revision', type: 'integer', nullable: true })
  publishedRevision: number | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ name: 'published_by', type: 'uuid', nullable: true })
  publishedBy: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
