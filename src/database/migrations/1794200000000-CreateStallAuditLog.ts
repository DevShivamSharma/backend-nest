import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Who changed what and when in the stall planning portal (plans saved, sent, approved...; rules
 * edited). Rows are only added. The event and hall are kept by id and by name, so a row still reads
 * right after ITPO renames or removes them. ITPO staff read it.
 */
export class CreateStallAuditLog1794200000000 implements MigrationInterface {
  name = 'CreateStallAuditLog1794200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE idp."T_STALL_AUDIT_LOG" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        at timestamptz NOT NULL DEFAULT now(),
        actor_id uuid,
        actor_name varchar(200),
        actor_email varchar(200),
        actor_type varchar(20),
        action varchar(40) NOT NULL,
        event_id uuid,
        event_name varchar(300),
        event_hall_id uuid,
        hall_name varchar(300),
        detail varchar(1000)
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_STALL_AUDIT_AT" ON idp."T_STALL_AUDIT_LOG" (at DESC)`);
    await queryRunner.query(`CREATE INDEX "IDX_STALL_AUDIT_EVENT" ON idp."T_STALL_AUDIT_LOG" (event_id)`);
    await queryRunner.query(`CREATE INDEX "IDX_STALL_AUDIT_ACTOR" ON idp."T_STALL_AUDIT_LOG" (actor_id)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE idp."T_STALL_AUDIT_LOG"`);
  }
}
