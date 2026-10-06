import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { UserEntity } from '../users/user.entity';
import type { OrganisationConfig } from './organisation-config';
import { OrganisationEntity } from './organisation.entity';

/** One saved state of an organisation's configuration. Rows are never updated. */
@Entity({ name: 'organisation_config_versions' })
export class OrganisationConfigVersionEntity {
  @PrimaryColumn({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @PrimaryColumn({ type: 'integer' })
  version!: number;

  @Column({ type: 'jsonb' })
  config!: OrganisationConfig;

  @Column({ name: 'changed_by', type: 'uuid', nullable: true })
  changedById!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => OrganisationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: OrganisationEntity;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'changed_by' })
  changedBy?: UserEntity | null;
}
