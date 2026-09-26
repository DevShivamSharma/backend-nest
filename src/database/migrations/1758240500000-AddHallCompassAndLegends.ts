import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `compass` and `legends` (jsonb) to the `hall` table.
 *
 * The SelfCare plan of every hall carries a north arrow (`direction`) and its own legend
 * (`legends`: the passage / no-construction / fire-curtain swatches and the gate-numbering
 * notes). Neither had a column, so both were lost on the way from the plan to the planner.
 *
 * Nullable with no default, like every other geometry column: NULL means "the plan has none".
 */
export class AddHallCompassAndLegends1758240500000 implements MigrationInterface {
  name = 'AddHallCompassAndLegends1758240500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE hall ADD COLUMN IF NOT EXISTS compass jsonb NULL`);
    await queryRunner.query(`ALTER TABLE hall ADD COLUMN IF NOT EXISTS legends jsonb NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE hall DROP COLUMN legends`);
    await queryRunner.query(`ALTER TABLE hall DROP COLUMN compass`);
  }
}
