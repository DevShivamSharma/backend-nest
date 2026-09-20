import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the optional multi-open-side list to stalls. `open_sides` is the source
 * of truth for rendering; the existing `gate_side` varchar stays and always
 * holds the first open side, so old consumers (and the Java contract) keep
 * working unchanged. NULL means "derive from gate_side" — no backfill needed.
 */
export class AddStallOpenSides1758240200000 implements MigrationInterface {
  name = 'AddStallOpenSides1758240200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS: see AddBlockedAreas1758240100000.
    await queryRunner.query(`ALTER TABLE stalls ADD COLUMN IF NOT EXISTS open_sides jsonb NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE stalls DROP COLUMN open_sides`);
  }
}
