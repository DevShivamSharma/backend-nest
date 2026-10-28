import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The planning rules. One set, applied to every hall; each event may switch rules off or back on
 * for itself, and those switches are kept per event.
 *
 * `T_RULE_SET` has a single row (id 1), made here with the standard rules: no switches stored
 * (a missing switch is on) and no values stored (the defaults apply).
 */
export class CreateRules1793900000000 implements MigrationInterface {
  name = 'CreateRules1793900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE idp."T_RULE_SET" (
        id smallint PRIMARY KEY CHECK (id = 1),
        switches jsonb NOT NULL DEFAULT '{}'::jsonb,
        rule_values jsonb NOT NULL DEFAULT '{}'::jsonb,
        doc_references jsonb NOT NULL DEFAULT '[]'::jsonb,
        drawing_profile varchar(40) NOT NULL DEFAULT 'free',
        -- The T_USER who last changed it; ITPO's table, so no foreign key.
        updated_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`INSERT INTO idp."T_RULE_SET" (id) VALUES (1)`);

    await queryRunner.query(`
      CREATE TABLE idp."T_EVENT_RULE_SWITCH" (
        -- T_HALL_BOOKING.id (ITPO's table, so no foreign key).
        event_id uuid NOT NULL,
        rule_id varchar(40) NOT NULL,
        enabled boolean NOT NULL,
        updated_by uuid NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (event_id, rule_id)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE idp."T_EVENT_RULE_SWITCH"`);
    await queryRunner.query(`DROP TABLE idp."T_RULE_SET"`);
  }
}
