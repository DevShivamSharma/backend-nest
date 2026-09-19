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
}
