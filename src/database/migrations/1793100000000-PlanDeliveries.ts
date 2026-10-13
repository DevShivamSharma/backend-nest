import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The outbox of plan pushes to a venue's system (docs/15 §3.1, §4.3). Publishing inserts a row
 * in its own transaction; a worker sends it later and retries, so a publish never waits on the
 * venue. `id` is also the delivery id the venue dedupes on, so it is made by the app: it is
 * inside the signed body. `payload` is the exact text sent (text, not jsonb, which would reorder
 * keys), so a retry sends the same bytes; null when the pre-checks failed and nothing was built.
 * `next_attempt_at` is the retry time while pending and the claim's lease while sending.
 */
export class PlanDeliveries1793100000000 implements MigrationInterface {
  name = 'PlanDeliveries1793100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE plan_deliveries (
        id uuid PRIMARY KEY,
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
        event_hall_id uuid NOT NULL REFERENCES event_halls (id) ON DELETE CASCADE,
        kind varchar(32) NOT NULL DEFAULT 'plan.published',
        plan_revision integer NOT NULL,
        payload text,
        status varchar(16) NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        last_status_code integer,
        venue_code varchar(64),
        last_error varchar(500),
        delivered_at timestamptz,
        resent_from uuid REFERENCES plan_deliveries (id) ON DELETE SET NULL,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT plan_deliveries_kind_check CHECK (kind = 'plan.published'),
        CONSTRAINT plan_deliveries_status_check CHECK (
          status IN ('pending', 'sending', 'delivered', 'failed')
          AND (status IN ('pending', 'sending')) = (next_attempt_at IS NOT NULL)
          AND (status = 'delivered') = (delivered_at IS NOT NULL)
          AND (status = 'failed' OR payload IS NOT NULL)
        ),
        CONSTRAINT plan_deliveries_attempts_check CHECK (attempts >= 0 AND plan_revision > 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX plan_deliveries_due_idx ON plan_deliveries (next_attempt_at)
        WHERE status IN ('pending', 'sending')`,
    );
    await queryRunner.query(
      `CREATE INDEX plan_deliveries_hall_idx ON plan_deliveries (event_hall_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX plan_deliveries_organisation_idx ON plan_deliveries (organisation_id, created_at DESC)`,
    );
    await queryRunner.query(`CREATE INDEX plan_deliveries_event_idx ON plan_deliveries (event_id)`);
    await queryRunner.query(`CREATE INDEX plan_deliveries_resent_from_idx ON plan_deliveries (resent_from)`);
    await queryRunner.query(`CREATE INDEX plan_deliveries_created_by_idx ON plan_deliveries (created_by)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE plan_deliveries`);
  }
}
