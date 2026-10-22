import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ITPO's users sign in here: an account stands for one ITPO user (T_USER.id), and an
 * organiser's account for its company too (T_ORGANIZATION.id). No foreign keys: ITPO's tables
 * are its own, and our database may not hold them (tests, local work).
 */
export class ItpoIdentity1793600000000 implements MigrationInterface {
  name = 'ItpoIdentity1793600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN itpo_user_id uuid,
        ADD COLUMN itpo_org_id uuid,
        ADD CONSTRAINT users_itpo_user_id_key UNIQUE (itpo_user_id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        DROP CONSTRAINT users_itpo_user_id_key,
        DROP COLUMN itpo_org_id,
        DROP COLUMN itpo_user_id
    `);
  }
}
