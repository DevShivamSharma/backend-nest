import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A hall's own rule switches, on top of the default rule set: ITPO staff switch a rule off or on
 * for one hall (`T_HALLS.id`, ITPO's table, so no foreign key). A hall without a row follows the
 * default; an event's own switches come after these.
 */
export class CreateHallRuleSwitches1794300000000 implements MigrationInterface {
  name = 'CreateHallRuleSwitches1794300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE idp."T_HALL_RULE_SWITCH" (
        hall_id integer NOT NULL,
        rule_id varchar(40) NOT NULL,
        enabled boolean NOT NULL,
        updated_by uuid NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (hall_id, rule_id)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE idp."T_HALL_RULE_SWITCH"`);
  }
}
