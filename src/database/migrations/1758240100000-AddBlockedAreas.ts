import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `blocked_areas` jsonb column to the `hall` table.
 *
 * This column stores the irregular-hall geometry as an array of axis-aligned rectangles
 * (outside masks, wall boundaries, zone overlays). It is nullable: existing halls and
 * any hall created without irregular geometry simply have NULL, and the planner treats
 * them as today's plain rectangular halls.
 */
export class AddBlockedAreas1758240100000 implements MigrationInterface {
  name = 'AddBlockedAreas1758240100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS: startup migrations (migrationsRun) must also succeed on a database
    // whose schema exists but has no TypeORM history table.
    await queryRunner.query(`ALTER TABLE hall ADD COLUMN IF NOT EXISTS blocked_areas jsonb NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE hall DROP COLUMN blocked_areas`);
  }
}
