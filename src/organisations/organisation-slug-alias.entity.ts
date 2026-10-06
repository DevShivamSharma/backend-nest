import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { OrganisationEntity } from './organisation.entity';

/** A slug the organisation used before. Shared links that carry it redirect to the current one. */
@Entity({ name: 'organisation_slug_aliases' })
export class OrganisationSlugAliasEntity {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  slug!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => OrganisationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: OrganisationEntity;
}
