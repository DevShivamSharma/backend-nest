import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { EntityRelationalHelper } from '../../../../../utils/relational-entity-helper';

/**
 * A session that was signed out. A token carries its session id; while a session is listed here,
 * its access and refresh tokens are refused. A row is only needed until the session's refresh
 * token would have expired anyway.
 */
@Entity({ name: 'T_AUTH_REVOKED_SESSION', schema: 'idp' })
export class AuthRevokedSessionEntity extends EntityRelationalHelper {
  @PrimaryColumn({ name: 'session_id', type: 'varchar', length: 100 })
  sessionId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'revoked_at', type: 'timestamptz', default: () => 'now()' })
  revokedAt: Date;

  @Index('T_AUTH_REVOKED_SESSION_expires_idx')
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
