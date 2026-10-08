import type { MigrationInterface, QueryRunner } from 'typeorm';
export class CsvFloorSource1791700000000 implements MigrationInterface {
  name = 'CsvFloorSource1791700000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE hall_floor_versions DROP CONSTRAINT hall_floor_versions_source_check, ADD CONSTRAINT hall_floor_versions_source_check CHECK (source IN ('blank','itpo','restore','drawing','json','csv'))`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    const rows = await q.query(`SELECT 1 FROM hall_floor_versions WHERE source='csv' LIMIT 1`);
    if (rows.length)
      throw new Error('Cannot remove CSV provenance while CSV floor versions exist.');
    await q.query(
      `ALTER TABLE hall_floor_versions DROP CONSTRAINT hall_floor_versions_source_check, ADD CONSTRAINT hall_floor_versions_source_check CHECK (source IN ('blank','itpo','restore','drawing','json'))`,
    );
  }
}
