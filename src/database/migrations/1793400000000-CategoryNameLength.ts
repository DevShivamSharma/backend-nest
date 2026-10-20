import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Category names as SelfCare keeps them: its `T_CODE_MASTER` names run past 80 characters
 * ("Processed Food, Organic Food, Beverages, Ingredients, Dairy Products, Spices and Agri
 * Produce"), and an import keeps them whole so the two lists read the same.
 */
export class CategoryNameLength1793400000000 implements MigrationInterface {
  name = 'CategoryNameLength1793400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE stall_categories ALTER COLUMN name TYPE varchar(160)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE stall_categories ALTER COLUMN name TYPE varchar(80) USING left(name, 80)`,
    );
  }
}
