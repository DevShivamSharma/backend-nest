import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source-options';
import { configuration } from '../src/config/configuration';
import { AddPlacementAndSplits1758240600000 } from '../src/database/migrations/1758240600000-AddPlacementAndSplits';

describe('placement migration with existing rows (real PostgreSQL)', () => {
  it('preserves identifiers/open sides, defaults old rotation, enforces lineage, and supports down/up', async () => {
    const db = new DataSource(buildDataSourceOptions(configuration().database));
    await db.initialize();
    expect(db.options.database).toBe('stall_designer_test');
    const q = db.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      await q.query('CREATE SCHEMA placement_migration_test');
      await q.query('SET LOCAL search_path TO placement_migration_test');
      await q.query('CREATE TABLE layouts (id bigint PRIMARY KEY)');
      await q.query(
        'CREATE TABLE stalls (id bigint PRIMARY KEY, layout_id bigint, stall_number varchar(32), open_sides jsonb)',
      );
      await q.query(`INSERT INTO layouts VALUES (1)`);
      await q.query(`INSERT INTO stalls VALUES (1, 1, '5-10', '["LEFT","BACK"]')`);
      const migration = new AddPlacementAndSplits1758240600000();
      await migration.up(q);
      expect(
        (
          await q.query(
            'SELECT stall_number, open_sides, rotation, parent_stall_number, is_split_parent FROM stalls',
          )
        )[0],
      ).toEqual({
        stall_number: '5-10',
        open_sides: ['LEFT', 'BACK'],
        rotation: 0,
        parent_stall_number: null,
        is_split_parent: false,
      });
      await q.query('ALTER TABLE stalls VALIDATE CONSTRAINT stalls_parent_identity_fk');
      await migration.down(q);
      await migration.up(q);
      expect((await q.query('SELECT stall_number, rotation FROM stalls'))[0]).toEqual({
        stall_number: '5-10',
        rotation: 0,
      });
    } finally {
      // Test schema and every migration DDL statement are rolled back together.
      await q.rollbackTransaction();
      await q.release();
      await db.destroy();
    }
  });
});
