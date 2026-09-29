import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plotting rules no longer belong to halls: they are one shared library, and each layout
 * records the rules chosen for it when its design starts (`layouts.rule_ids`).
 *
 * The hall links and the "all halls" flag of 1758240800000 are dropped. `down` recreates them
 * empty: which hall a rule was meant for cannot be recovered.
 */
export class IndependentPlannerRules1758240900000 implements MigrationInterface {
  name = 'IndependentPlannerRules1758240900000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS planner_rule_halls`);
    await q.query(`ALTER TABLE planner_rules DROP COLUMN IF EXISTS applies_to_all`);
    await q.query(`ALTER TABLE layouts ADD COLUMN IF NOT EXISTS rule_ids jsonb NULL`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE layouts DROP COLUMN IF EXISTS rule_ids`);
    await q.query(
      `ALTER TABLE planner_rules ADD COLUMN IF NOT EXISTS applies_to_all boolean NOT NULL DEFAULT false`,
    );
    await q.query(`
      CREATE TABLE IF NOT EXISTS planner_rule_halls (
        rule_id  bigint NOT NULL REFERENCES planner_rules (id) ON DELETE CASCADE,
        hall_id  bigint NOT NULL REFERENCES hall (id) ON DELETE CASCADE,
        PRIMARY KEY (rule_id, hall_id)
      )
    `);
  }
}
