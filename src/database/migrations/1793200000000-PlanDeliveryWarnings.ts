import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the venue's system said alongside a successful push, e.g. SelfCare's
 * `HALL_HAS_NO_BASE_LAYOUT`: the stalls were saved, but something needs a person's eye. Codes
 * only, as the venue sent them; the app words them.
 */
export class PlanDeliveryWarnings1793200000000 implements MigrationInterface {
  name = 'PlanDeliveryWarnings1793200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE plan_deliveries
        ADD COLUMN warnings text[] NOT NULL DEFAULT '{}',
        ADD CONSTRAINT plan_deliveries_warnings_check CHECK (cardinality(warnings) <= 10)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE plan_deliveries
        DROP CONSTRAINT plan_deliveries_warnings_check,
        DROP COLUMN warnings
    `);
  }
}
