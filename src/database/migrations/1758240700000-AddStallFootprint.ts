import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Custom (polygon) stalls: `footprint` holds the outline of an L-shaped or otherwise irregular
 * stall, `open_edges` which of its edges are open. Both NULL for every existing stall, which
 * therefore stays the width x length rectangle it always was.
 */
export class AddStallFootprint1758240700000 implements MigrationInterface {
  name = 'AddStallFootprint1758240700000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE stalls ADD COLUMN IF NOT EXISTS footprint jsonb NULL`);
    await q.query(`ALTER TABLE stalls ADD COLUMN IF NOT EXISTS open_edges jsonb NULL`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE stalls DROP COLUMN IF EXISTS open_edges`);
    await q.query(`ALTER TABLE stalls DROP COLUMN IF EXISTS footprint`);
  }
}
