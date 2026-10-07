import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A hall's floor can now come from an imported drawing (PDF, DXF or image of the plan). */
export class DrawingFloorSource1791300000000 implements MigrationInterface {
  name = 'DrawingFloorSource1791300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE hall_floor_versions
        DROP CONSTRAINT hall_floor_versions_source_check,
        ADD CONSTRAINT hall_floor_versions_source_check
          CHECK (source IN ('blank', 'itpo', 'restore', 'drawing'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE hall_floor_versions
        DROP CONSTRAINT hall_floor_versions_source_check,
        ADD CONSTRAINT hall_floor_versions_source_check
          CHECK (source IN ('blank', 'itpo', 'restore'))
    `);
  }
}
