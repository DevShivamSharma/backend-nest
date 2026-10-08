import type { MigrationInterface, QueryRunner } from 'typeorm';
/** Reader fixes reprocess older, unsaved imports instead of reopening stale detection results. */
export class PlanReaderVersion1791600000000 implements MigrationInterface {
  name = 'PlanReaderVersion1791600000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE floor_plan_imports ADD COLUMN reader_version varchar(40) NOT NULL DEFAULT 'legacy'`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE floor_plan_imports DROP COLUMN reader_version`);
  }
}
