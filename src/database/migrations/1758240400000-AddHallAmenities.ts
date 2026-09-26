import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `amenities` jsonb column to the `hall` table.
 *
 * Utility icons from the source layout's `helper_text` — toilets, stairs/lifts, entries. They
 * are visual only: the source plan places some of them OUTSIDE the hall outline (Hall 8-9-10's
 * Hall 10 toilet block sits above FOYER C), so they are never geometry and never take part in
 * placement validation. Without this column the icons had nowhere to live, which is why they
 * never reached the planner.
 *
 * Nullable with no default, like every other geometry column (AddLayoutRulesAndStallIdentity):
 * NULL means "this hall has no amenities", which is the correct state for a hall seeded before
 * the column existed.
 */
export class AddHallAmenities1758240400000 implements MigrationInterface {
  name = 'AddHallAmenities1758240400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE hall ADD COLUMN IF NOT EXISTS amenities jsonb NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE hall DROP COLUMN amenities`);
  }
}
