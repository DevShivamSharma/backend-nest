import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PricingLibrary1791040000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE IF NOT EXISTS pricing_libraries (
      id varchar(80) PRIMARY KEY,
      source_hash varchar(64) NOT NULL,
      imported_at timestamptz NOT NULL DEFAULT now(),
      catalog jsonb NOT NULL
    )`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE IF EXISTS pricing_libraries');
  }
}
