import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PlanningZonesAndPublish1791000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE hall ADD COLUMN IF NOT EXISTS planning_zones jsonb`);
    await queryRunner.query(`ALTER TABLE layouts ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'DRAFT'`);
    await queryRunner.query(`ALTER TABLE layouts ADD COLUMN IF NOT EXISTS published_at timestamptz`);
    await queryRunner.query(`ALTER TABLE layouts ADD COLUMN IF NOT EXISTS publish_overrides jsonb`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE layouts DROP COLUMN IF EXISTS publish_overrides, DROP COLUMN IF EXISTS published_at, DROP COLUMN IF EXISTS status`);
    await queryRunner.query(`ALTER TABLE hall DROP COLUMN IF EXISTS planning_zones`);
  }
}
