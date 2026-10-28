import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The proof an ITPO reviewer attaches when sending an external event's hall plan back (images and
 * PDF, 5 MB each). Kept with the plan's event hall (`T_EVENT_HALL.id`, ITPO's table, so no foreign
 * key) and the revision that was rejected; a new round of review replaces them.
 */
export class CreateStallPlanAttachments1794100000000 implements MigrationInterface {
  name = 'CreateStallPlanAttachments1794100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE idp."T_STALL_PLAN_ATTACHMENT" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_hall_id uuid NOT NULL,
        revision integer NOT NULL,
        file_name varchar(255) NOT NULL,
        mime_type varchar(100) NOT NULL,
        size integer NOT NULL,
        data bytea NOT NULL,
        uploaded_by uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_STALL_PLAN_ATTACHMENT_HALL" ON idp."T_STALL_PLAN_ATTACHMENT" (event_hall_id)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE idp."T_STALL_PLAN_ATTACHMENT"`);
  }
}
