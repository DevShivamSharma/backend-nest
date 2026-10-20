import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The area a hall drawing writes on a stall ("120 m²"), where it is more than the box drawn on
 * the grid. Null: the stall's area is its cells, as every stall's is so far.
 */
export class StallLabelArea1793500000000 implements MigrationInterface {
  name = 'StallLabelArea1793500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE plan_stalls ADD COLUMN label_area double precision`);
    await queryRunner.query(`ALTER TABLE published_stalls ADD COLUMN label_area double precision`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE published_stalls DROP COLUMN label_area`);
    await queryRunner.query(`ALTER TABLE plan_stalls DROP COLUMN label_area`);
  }
}
