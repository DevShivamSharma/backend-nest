import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { MembershipScope } from '../access/membership-scope';
import { RoleEntity } from '../roles/role.entity';
import { OrganisationEntity } from '../organisations/organisation.entity';
import { UserEntity } from '../users/user.entity';

/**
 * An emailed offer to join an organisation with a role. Only the SHA-256 of the token is
 * stored; the token itself exists in the emailed link alone.
 */
@Entity({ name: 'invitations' })
export class InvitationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ type: 'varchar', length: 254 })
  email!: string;

  @Column({ name: 'role_id', type: 'uuid' })
  roleId!: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  scope!: MembershipScope;

  @Column({ name: 'token_hash', type: 'char', length: 64, unique: true, select: false })
  tokenHash!: string;

  @Column({ name: 'invited_by', type: 'uuid', nullable: true })
  invitedById!: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => OrganisationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: OrganisationEntity;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'invited_by' })
  invitedBy?: UserEntity | null;

  @ManyToOne(() => RoleEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'role_id' })
  role?: RoleEntity;
}
