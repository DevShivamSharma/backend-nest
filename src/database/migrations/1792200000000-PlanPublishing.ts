import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Publishing a stall plan: which saved revision is the published one, when and by whom. A plan
 * keeps being drawn after it is published; the published revision says which one counts.
 */
export class PlanPublishing1792200000000 implements MigrationInterface {
  name = 'PlanPublishing1792200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE stall_plans
        ADD COLUMN published_revision integer,
        ADD COLUMN published_at timestamptz,
        ADD COLUMN published_by uuid REFERENCES users (id) ON DELETE SET NULL,
        ADD CONSTRAINT stall_plans_published_check CHECK (
          (published_revision IS NULL) = (published_at IS NULL)
          AND (published_revision IS NULL OR published_revision BETWEEN 1 AND revision)
        )
    `);
    await queryRunner.query(
      `CREATE INDEX stall_plans_published_by_idx ON stall_plans (published_by)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE stall_plans
        DROP CONSTRAINT stall_plans_published_check,
        DROP COLUMN published_by,
        DROP COLUMN published_at,
        DROP COLUMN published_revision
    `);
  }
}
