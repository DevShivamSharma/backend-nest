import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Table `stalls` (Stall.java). Column names `posx`, `posz`, `gate_side` are the Java
 * `@Column` names (Stall.java:21,24,29); the JSON names stay `posX`, `posZ`, `gateSide`.
 */
@Entity({ name: 'stalls' })
export class StallEntity {
  @Column({ type: 'double precision', default: 0 })
  rotation!: number;

  @Column({ name: 'parent_stall_number', type: 'varchar', length: 255, nullable: true })
  parentStallNumber!: string | null;

  @Column({ name: 'is_split_parent', type: 'boolean', default: false })
  isSplitParent!: boolean;

  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'BY DEFAULT' })
  id!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name!: string | null;

  @Column({ type: 'double precision' })
  width!: number;

  @Column({ type: 'double precision' })
  length!: number;

  @Column({ type: 'double precision' })
  height!: number;

  @Column({ name: 'posx', type: 'double precision' })
  posX!: number;

  @Column({ name: 'posz', type: 'double precision' })
  posZ!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  color!: string | null;

  @Column({ name: 'gate_side', type: 'varchar', length: 255, nullable: true })
  gateSide!: string | null;

  /** Every open side (1-4, any combination). NULL on old rows = derive from gateSide. */
  @Column({ name: 'open_sides', type: 'jsonb', nullable: true })
  openSides!: string[] | null;

  @Column({ name: 'layout_id', type: 'bigint' })
  layoutId!: number;

  /**
   * Stable, human-facing identity ("STALL-001"). Unlike `id`, it survives a PUT (which
   * re-inserts every row, ADR-012) and is never reused within a layout.
   */
  @Column({ name: 'stall_number', type: 'varchar', length: 255, nullable: true })
  stallNumber!: string | null;

  /** AVAILABLE, BOOKED or CANCELLED. A cancelled stall keeps its number but occupies no space. */
  @Column({ type: 'varchar', length: 16, default: 'AVAILABLE' })
  status!: string;

  /** Id of the configured stall type it was created from ("stall-3x2"), or NULL for custom. */
  @Column({ name: 'stall_type', type: 'varchar', length: 64, nullable: true })
  stallTypeId!: string | null;
}
