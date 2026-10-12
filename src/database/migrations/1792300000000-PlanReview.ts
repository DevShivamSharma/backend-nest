import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The venue's approval of an external event's plan: the organiser sends a saved revision, the
 * venue approves it (which publishes it) or sends it back with a note.
 */
export class PlanReview1792300000000 implements MigrationInterface {
  name = 'PlanReview1792300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE stall_plans
        ADD COLUMN review_status varchar(16),
        ADD COLUMN review_revision integer,
        ADD COLUMN submitted_at timestamptz,
        ADD COLUMN submitted_by uuid REFERENCES users (id) ON DELETE SET NULL,
        ADD COLUMN reviewed_at timestamptz,
        ADD COLUMN reviewed_by uuid REFERENCES users (id) ON DELETE SET NULL,
        ADD COLUMN review_note varchar(1000),
        ADD CONSTRAINT stall_plans_review_check CHECK (
          (review_status IS NULL OR review_status IN ('submitted', 'approved', 'rejected'))
          AND (review_status IS NULL) = (review_revision IS NULL)
          AND (review_status IS NULL) = (submitted_at IS NULL)
          AND (review_status IS NULL OR review_revision BETWEEN 1 AND revision)
          AND ((review_status IN ('approved', 'rejected')) = (reviewed_at IS NOT NULL))
        )
    `);
    await queryRunner.query(
      `CREATE INDEX stall_plans_submitted_by_idx ON stall_plans (submitted_by)`,
    );
    await queryRunner.query(
      `CREATE INDEX stall_plans_reviewed_by_idx ON stall_plans (reviewed_by)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE stall_plans
        DROP CONSTRAINT stall_plans_review_check,
        DROP COLUMN review_note,
        DROP COLUMN reviewed_by,
        DROP COLUMN reviewed_at,
        DROP COLUMN submitted_by,
        DROP COLUMN submitted_at,
        DROP COLUMN review_revision,
        DROP COLUMN review_status
    `);
  }
}
