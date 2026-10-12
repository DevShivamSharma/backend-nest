import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An event's lifecycle: drafted, then scheduled (its stalls may be sold), then completed; or
 * cancelled from either of the first two. Minimal on purpose — booking and settlement hang
 * off `scheduled` and `completed` later.
 */
export class EventStatus1792500000000 implements MigrationInterface {
  name = 'EventStatus1792500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE events
        ADD COLUMN status varchar(16) NOT NULL DEFAULT 'draft',
        ADD COLUMN completed_at timestamptz,
        ADD COLUMN cancelled_at timestamptz,
        ADD COLUMN cancel_reason varchar(500),
        ADD CONSTRAINT events_status_check CHECK (
          status IN ('draft', 'scheduled', 'completed', 'cancelled')
          AND (status = 'completed') = (completed_at IS NOT NULL)
          AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
          AND (cancel_reason IS NULL OR status = 'cancelled')
        )
    `);
    await queryRunner.query(
      `CREATE INDEX events_organisation_status_idx ON events (organisation_id, status)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE events
        DROP CONSTRAINT events_status_check,
        DROP COLUMN cancel_reason,
        DROP COLUMN cancelled_at,
        DROP COLUMN completed_at,
        DROP COLUMN status
    `);
  }
}
