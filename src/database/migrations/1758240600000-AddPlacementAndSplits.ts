import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPlacementAndSplits1758240600000 implements MigrationInterface {
  name = 'AddPlacementAndSplits1758240600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE stalls ADD COLUMN IF NOT EXISTS rotation double precision NOT NULL DEFAULT 0`,
    );
    await q.query(`ALTER TABLE stalls ALTER COLUMN stall_number TYPE varchar(255)`);
    await q.query(
      `ALTER TABLE stalls ADD COLUMN IF NOT EXISTS parent_stall_number varchar(255) NULL`,
    );
    await q.query(
      `ALTER TABLE stalls ADD COLUMN IF NOT EXISTS is_split_parent boolean NOT NULL DEFAULT false`,
    );
    await q.query(`CREATE TABLE IF NOT EXISTS layout_splits (
      layout_id bigint NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
      parent_number varchar(255) NOT NULL,
      idempotency_key varchar(128) NOT NULL,
      request_hash varchar(64) NOT NULL,
      parent_snapshot jsonb NOT NULL,
      child_numbers jsonb NOT NULL,
      PRIMARY KEY (layout_id, parent_number),
      UNIQUE (layout_id, idempotency_key)
    )`);
    // NOT VALID preserves legacy rows without renumbering or rewriting geometry.
    await q.query(`ALTER TABLE stalls ADD CONSTRAINT stalls_parent_identity_fk
      FOREIGN KEY (layout_id, parent_stall_number) REFERENCES layout_splits(layout_id, parent_number)
      DEFERRABLE INITIALLY DEFERRED NOT VALID`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE stalls DROP CONSTRAINT IF EXISTS stalls_parent_identity_fk`);
    await q.query(`DROP TABLE IF EXISTS layout_splits`);
    await q.query(`ALTER TABLE stalls DROP COLUMN IF EXISTS is_split_parent`);
    await q.query(`ALTER TABLE stalls DROP COLUMN IF EXISTS parent_stall_number`);
    await q.query(`ALTER TABLE stalls DROP COLUMN IF EXISTS rotation`);
    // Keep widened identifiers: shrinking would lose or reject previously issued values.
  }
}
