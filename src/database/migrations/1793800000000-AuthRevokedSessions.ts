import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sessions that were signed out. A token carries its session id; while a session is listed here,
 * its access and refresh tokens are refused. A row is only needed until the session's refresh
 * token would have expired anyway.
 */
export class AuthRevokedSessions1793800000000 implements MigrationInterface {
  name = 'AuthRevokedSessions1793800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE idp."T_AUTH_REVOKED_SESSION" (
        session_id varchar(100) PRIMARY KEY,
        user_id uuid NOT NULL,
        revoked_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "T_AUTH_REVOKED_SESSION_expires_idx" ON idp."T_AUTH_REVOKED_SESSION" (expires_at)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE idp."T_AUTH_REVOKED_SESSION"`);
  }
}
