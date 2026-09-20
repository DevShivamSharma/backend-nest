import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

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
}
