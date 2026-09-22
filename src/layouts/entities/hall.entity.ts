import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import type {
  HallOpening,
  HallZone,
  LayoutRules,
  Point,
} from '../placement/placement-rules';

export type BlockedAreaKind = 'outside' | 'wall' | 'zone';

/**
 * One rectangle of irregular-hall geometry (centre-origin coordinates, like stalls).
 * Mirrors the frontend `BlockedArea` in `planner/models/hall.model.ts`.
 */
export interface BlockedArea {
  posX: number;
  posZ: number;
  width: number;
  length: number;
  kind: BlockedAreaKind;
  color: string;
  title?: string;
}

/**
 * Table `hall` — singular, as in the Java `@Table(name = "hall")` (Hall.java:6).
 *
 * Every business column is nullable because the Java fields were wrapper types with no
 * `nullable = false` (docs/03-database-model.md section 2). Validation lives in LayoutValidator.
 *
 * `id` is bigint; the pg driver is configured in data-source-options.ts to parse int8 as a
 * JS number.
 */
@Entity({ name: 'hall' })
export class HallEntity {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'BY DEFAULT' })
  id!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  shape!: string | null;

  @Column({ type: 'double precision', nullable: true })
  width!: number | null;

  @Column({ type: 'double precision', nullable: true })
  length!: number | null;

  @Column({ type: 'double precision', nullable: true })
  radius!: number | null;

  @Column({ type: 'jsonb', name: 'blocked_areas', nullable: true })
  blockedAreas!: BlockedArea[] | null;

  /** Hall outline polygon (metres, centre-origin). NULL = the width x length rectangle. */
  @Column({ type: 'jsonb', nullable: true })
  boundary!: Point[] | null;

  /** Restricted regions: passages, no-construction zones, exit access, curtains... */
  @Column({ type: 'jsonb', nullable: true })
  zones!: HallZone[] | null;

  /** Doors in the hall wall; the area in front of each must stay free. */
  @Column({ type: 'jsonb', nullable: true })
  openings!: HallOpening[] | null;

  /** Text labels from the source layout (gate names, foyers). Visual only. */
  @Column({ type: 'jsonb', nullable: true })
  markers!: HallMarker[] | null;

  /** Placement rules in metres. NULL = the hall is not rule-driven (legacy checks only). */
  @Column({ type: 'jsonb', nullable: true })
  rules!: Partial<LayoutRules> | null;
}

/** A text label on the plan, e.g. a gate name. */
export interface HallMarker {
  text: string;
  position: Point;
}
