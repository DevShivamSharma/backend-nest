import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stalls that are not whole rectangles: the 1 m cells cut out of a stall, as [column, row]
 * from its top-left corner. Empty for a plain rectangle, which every stall so far is.
 */
export class StallCutCells1793300000000 implements MigrationInterface {
  name = 'StallCutCells1793300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE plan_stalls
        ADD COLUMN cut_cells jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE published_stalls
        ADD COLUMN cut_cells jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE published_stalls DROP COLUMN cut_cells`);
    await queryRunner.query(`ALTER TABLE plan_stalls DROP COLUMN cut_cells`);
  }
}
