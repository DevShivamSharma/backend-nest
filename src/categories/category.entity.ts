import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const CATEGORY_STATUSES = ['active', 'inactive'] as const;
export type CategoryStatus = (typeof CATEGORY_STATUSES)[number];

/**
 * A category stalls are sold under (Premium, Corner, F&B...), from the organisation's master
 * list. Inactive ones stay on what already uses them, but are not offered again.
 */
@Entity({ name: 'stall_categories' })
export class StallCategoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'varchar', length: 8, default: 'active' })
  status!: CategoryStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

/** A category an event hall sells; the planner offers only these on that hall. */
@Entity({ name: 'event_hall_categories' })
export class EventHallCategoryEntity {
  @PrimaryColumn({ name: 'event_hall_id', type: 'uuid' })
  eventHallId!: string;

  @PrimaryColumn({ name: 'category_id', type: 'uuid' })
  categoryId!: string;
}
