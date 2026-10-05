import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import type { HallOpening, HallZone, LayoutRules, Point } from '../placement/placement-rules';

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
  strokeColor?: string;
  /** Hover text of the source plan, e.g. "Pillar". */
  title?: string;
  /** SelfCare `visibleInView: false` (fire curtains): not drawn in the view, still blocking. */
  hidden?: boolean;
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
  @Column({ type: 'jsonb', name: 'planning_zones', nullable: true })
  planningZones!: import('../placement/planning-zones').PlanningZone[] | null;
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

  /**
   * Utility icons from the source layout's `helper_text` — toilets, stairs/lifts, entries.
   * Visual only: the plan places some of them OUTSIDE the hall outline, so they are never
   * treated as geometry and never take part in placement validation.
   */
  @Column({ type: 'jsonb', nullable: true })
  amenities!: HallAmenity[] | null;

  /** The plan's north arrow (SelfCare `direction`). Visual only. */
  @Column({ type: 'jsonb', nullable: true })
  compass!: HallCompass | null;

  /** The plan's own legend rows (SelfCare `legends`). Visual only; markup is stored as text. */
  @Column({ type: 'jsonb', nullable: true })
  legends!: HallLegend[] | null;

  /** Placement rules in metres. NULL = default 3 m passage, no optional peripheral/grid restrictions. */
  @Column({ type: 'jsonb', nullable: true })
  rules!: Partial<LayoutRules> | null;
}

/**
 * A utility icon on the plan. `kind` is also the SVG's base name under `assets/images/`.
 * `position` is the icon centre; `anchor` (top-left of the SelfCare icon card it belongs to) and
 * `slot` (its place in that card's row) let the frontend draw the card as the plan does.
 */
export interface HallAmenity {
  kind: string;
  label: string;
  position: Point;
  anchor?: Point | null;
  slot?: number | null;
}

/** The plan's north arrow: rose centre, side in metres, clockwise degrees, letter offset. */
export interface HallCompass {
  position: Point;
  size: number;
  rotation: number;
  label: string;
  labelOffset: Point;
}

/** One legend row: a colour swatch OR a markup note (untrusted; the frontend renders text only). */
export interface HallLegend {
  label: string;
  colorCode?: string | null;
  htmlContent?: string | null;
  visibleInViewMode?: boolean;
  visibleInBookMode?: boolean;
}

/** A text label on the plan, e.g. a gate name. */
export interface HallMarker {
  text: string;
  position: Point;
}
