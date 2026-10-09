import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import type { Point } from '../venues/floor-plan/plan.types';
import type { StallSide } from '../rules/rule-engine';

export const STALL_SCHEMES = ['shell', 'raw'] as const;
export type StallScheme = (typeof STALL_SCHEMES)[number];

export const PLAN_OBJECT_KINDS = ['line', 'rect', 'circle', 'polyline', 'text'] as const;
export type PlanObjectKind = (typeof PLAN_OBJECT_KINDS)[number];

/** The stall plan of one hall of an event. `revision` goes up with every save. */
@Entity({ name: 'stall_plans' })
export class StallPlanEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_hall_id', type: 'uuid' })
  eventHallId!: string;

  @Column({ type: 'integer', default: 0 })
  revision!: number;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedById!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

/** A named part of the floor, of any shape: one outline, floor metres. */
@Entity({ name: 'plan_zones' })
export class PlanZoneEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'plan_id', type: 'uuid' })
  planId!: string;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'varchar', length: 9 })
  color!: string;

  @Column({ type: 'jsonb' })
  polygon!: Point[];

  @Column({ type: 'double precision' })
  area!: number;

  @Column({ name: 'sort_order', type: 'integer' })
  sortOrder!: number;
}

/** A stall: a rectangle on the floor's axes, with what ITPO's `T_STALLS` keeps about it. */
@Entity({ name: 'plan_stalls' })
export class PlanStallEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'plan_id', type: 'uuid' })
  planId!: string;

  @Column({ name: 'zone_id', type: 'uuid', nullable: true })
  zoneId!: string | null;

  @Column({ name: 'island_number', type: 'varchar', length: 40, nullable: true })
  islandNumber!: string | null;

  @Column({ name: 'stall_number', type: 'varchar', length: 20 })
  stallNumber!: string;

  @Column({ type: 'double precision' })
  x!: number;

  @Column({ type: 'double precision' })
  y!: number;

  @Column({ type: 'double precision' })
  width!: number;

  @Column({ type: 'double precision' })
  depth!: number;

  @Column({ name: 'open_sides', type: 'text', array: true, default: () => "'{}'" })
  openSides!: StallSide[];

  @Column({ type: 'varchar', length: 8, default: 'shell' })
  scheme!: StallScheme;

  @Column({ name: 'category_ids', type: 'uuid', array: true, default: () => "'{}'" })
  categoryIds!: string[];

  @Column({ name: 'is_premium', type: 'boolean', default: false })
  isPremium!: boolean;

  @Column({ name: 'is_blocked', type: 'boolean', default: false })
  isBlocked!: boolean;

  @Column({ name: 'is_fnb', type: 'boolean', default: false })
  isFnb!: boolean;

  @Column({ name: 'is_branding', type: 'boolean', default: false })
  isBranding!: boolean;

  @Column({ name: 'is_horseshoe', type: 'boolean', default: false })
  isHorseshoe!: boolean;

  @Column({ name: 'is_marquee_available', type: 'boolean', default: false })
  isMarqueeAvailable!: boolean;

  @Column({ name: 'is_restricted_for_overseas', type: 'boolean', default: false })
  isRestrictedForOverseas!: boolean;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'varchar', length: 200, nullable: true })
  location!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;
}

/** One seat: a small rectangle with its row and number, e.g. C-10. */
@Entity({ name: 'plan_seats' })
export class PlanSeatEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'plan_id', type: 'uuid' })
  planId!: string;

  @Column({ name: 'zone_id', type: 'uuid', nullable: true })
  zoneId!: string | null;

  @Column({ name: 'row_label', type: 'varchar', length: 4 })
  rowLabel!: string;

  @Column({ name: 'seat_number', type: 'integer' })
  seatNumber!: number;

  @Column({ type: 'double precision' })
  x!: number;

  @Column({ type: 'double precision' })
  y!: number;

  @Column({ type: 'double precision' })
  width!: number;

  @Column({ type: 'double precision' })
  depth!: number;

  @Column({ name: 'category_id', type: 'uuid', nullable: true })
  categoryId!: string | null;
}

/**
 * A drawing on the plan: a line, rectangle, circle, polyline or text, floor metres. Drawing
 * only; the rules do not see it.
 */
@Entity({ name: 'plan_objects' })
export class PlanObjectEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'plan_id', type: 'uuid' })
  planId!: string;

  @Column({ type: 'varchar', length: 10 })
  kind!: PlanObjectKind;

  @Column({ type: 'jsonb' })
  points!: Point[];

  @Column({ type: 'varchar', length: 120, nullable: true })
  text!: string | null;

  @Column({ type: 'varchar', length: 9 })
  color!: string;

  @Column({ name: 'sort_order', type: 'integer' })
  sortOrder!: number;
}
