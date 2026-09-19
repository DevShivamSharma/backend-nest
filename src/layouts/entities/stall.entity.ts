import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Table `stalls` (Stall.java). Column names `posx`, `posz`, `gate_side` are the Java
 * `@Column` names (Stall.java:21,24,29); the JSON names stay `posX`, `posZ`, `gateSide`.
 */
@Entity({ name: 'stalls' })
export class StallEntity {
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

  @Column({ name: 'layout_id', type: 'bigint' })
  layoutId!: number;
}
