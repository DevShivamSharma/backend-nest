import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

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
}
