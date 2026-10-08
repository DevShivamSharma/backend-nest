import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** A venue system we exchange data with. */
export type ExternalSystem = 'itpo' | 'json' | 'csv';

/** The kinds of our records a venue system has its own id for. */
export type ExternalEntityType = 'hall';

/**
 * Which record of a venue's own system one of ours stands for: ITPO's hall 56 is our hall X.
 * One-to-one in both directions, per organisation and system. Re-importing finds the hall it
 * made last time through this, instead of creating a second one.
 */
@Entity({ name: 'external_refs' })
export class ExternalRefEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ type: 'varchar', length: 32 })
  system!: ExternalSystem;

  @Column({ name: 'entity_type', type: 'varchar', length: 32 })
  entityType!: ExternalEntityType;

  @Column({ name: 'local_id', type: 'uuid' })
  localId!: string;

  @Column({ name: 'external_id', type: 'varchar', length: 64 })
  externalId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
