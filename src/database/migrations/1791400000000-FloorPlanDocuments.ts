import type { MigrationInterface, QueryRunner } from 'typeorm';
export class FloorPlanDocuments1791400000000 implements MigrationInterface {
  name = 'FloorPlanDocuments1791400000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE floor_plan_imports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      file_name varchar(200) NOT NULL, file_hash varchar(64) NOT NULL,
      status varchar(16) NOT NULL CHECK (status IN ('reading','ready','failed')),
      error text, revision integer NOT NULL DEFAULT 1,
      pages jsonb NOT NULL DEFAULT '[]', committed jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(
      'CREATE INDEX floor_plan_imports_venue_hash_idx ON floor_plan_imports(organisation_id, venue_id, file_hash)',
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE floor_plan_imports');
  }
}
