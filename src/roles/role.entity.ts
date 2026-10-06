import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { OrganisationEntity } from '../organisations/organisation.entity';

/**
 * Where a role applies. An `event` role is always limited to one event and its halls, so it can
 * only be given once events exist (modules D and H).
 */
export enum RoleScopeKind {
  Organisation = 'organisation',
  Event = 'event',
}

/** The key of the locked owner role every organisation keeps at least one member in. */
export const OWNER_ROLE_KEY = 'venue_admin';

/**
 * A named set of permissions, defined by the Super Admin. A role without an organisation is
 * offered to every organisation; one with an organisation exists only there.
 */
@Entity({ name: 'roles' })
export class RoleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Null for a platform-wide role. */
  @Column({ name: 'organisation_id', type: 'uuid', nullable: true })
  organisationId!: string | null;

  /** Stable identifier, unique among the roles an organisation can see. */
  @Column({ type: 'varchar', length: 48 })
  key!: string;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  description!: string | null;

  @Column({ name: 'scope_kind', type: 'varchar', length: 16 })
  scopeKind!: RoleScopeKind;

  /** Stored as given; read through `effectivePermissions`, which a locked role overrides. */
  @Column({ type: 'text', array: true, default: () => "'{}'::text[]" })
  permissions!: string[];

  /** Shipped with the platform: cannot be deleted and keeps its key. */
  @Column({ name: 'is_system', type: 'boolean', default: false })
  isSystem!: boolean;

  /** Always holds every permission; nobody edits it. Only the owner role is locked. */
  @Column({ name: 'is_locked', type: 'boolean', default: false })
  isLocked!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => OrganisationEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: OrganisationEntity | null;
}
