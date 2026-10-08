import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module C, rules: an organisation's rule sets (which safety rules are on, their values, the
 * documents they come from, and what the venue's system can store).
 */
export class Rules1791800000000 implements MigrationInterface {
  name = 'Rules1791800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE rule_sets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        name varchar(120) NOT NULL,
        description varchar(500),
        is_default boolean NOT NULL DEFAULT false,
        switches jsonb NOT NULL DEFAULT '{}',
        rule_values jsonb NOT NULL DEFAULT '{}',
        doc_references jsonb NOT NULL DEFAULT '[]',
        drawing_profile varchar(40) NOT NULL DEFAULT 'free',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT rule_sets_organisation_name_key UNIQUE (organisation_id, name)
      )
    `);
    // At most one default rule set per organisation.
    await queryRunner.query(
      `CREATE UNIQUE INDEX rule_sets_one_default ON rule_sets (organisation_id) WHERE is_default`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE rule_sets');
  }
}
