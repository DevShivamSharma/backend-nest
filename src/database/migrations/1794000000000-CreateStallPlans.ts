import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The stall plan of an event hall, as a draft: what the planner saves, before it is published to
 * ITPO's `T_STALLS`. One row per event hall (`T_EVENT_HALL.id`, ITPO's table, so no foreign key).
 *
 * `content` holds the zones, stalls, seats and drawings; `revision` counts the saves, and is what
 * a save or publish must name, so two people cannot overwrite each other. The `review_*` columns
 * are the approval of an external event's plan (submitted, approved, rejected); the `published_*`
 * ones say which revision was last written to `T_STALLS`.
 */
export class CreateStallPlans1794000000000 implements MigrationInterface {
  name = 'CreateStallPlans1794000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE idp."T_STALL_PLAN" (
        event_hall_id uuid PRIMARY KEY,
        revision integer NOT NULL DEFAULT 0,
        content jsonb NOT NULL DEFAULT '{"zones":[],"stalls":[],"seats":[],"objects":[]}'::jsonb,
        updated_by uuid,
        review_status varchar(16) CHECK (review_status IN ('submitted', 'approved', 'rejected')),
        review_revision integer,
        submitted_at timestamptz,
        submitted_by uuid,
        reviewed_at timestamptz,
        reviewed_by uuid,
        review_note varchar(1000),
        published_revision integer,
        published_at timestamptz,
        published_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE idp."T_STALL_PLAN"`);
  }
}
