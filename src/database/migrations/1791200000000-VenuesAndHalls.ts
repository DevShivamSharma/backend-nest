import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module B, venues and halls: an organisation's venues, their halls, every version of each
 * hall's floor, and the ids the venue's own systems use for our records.
 *
 * A hall's floor is never edited in place. Each change (an import, a restore) adds a version;
 * the hall points at its current one, and an event-hall will keep the version it was drawn on.
 */
export class VenuesAndHalls1791200000000 implements MigrationInterface {
  name = 'VenuesAndHalls1791200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE venues (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        name varchar(160) NOT NULL,
        code varchar(40),
        address varchar(300),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT venues_organisation_name_key UNIQUE (organisation_id, name)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE halls (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        venue_id uuid NOT NULL REFERENCES venues (id) ON DELETE CASCADE,
        name varchar(120) NOT NULL,
        code varchar(40),
        level varchar(40),
        uses jsonb NOT NULL DEFAULT '{}'::jsonb,
        width double precision NOT NULL,
        depth double precision NOT NULL,
        floor_area double precision NOT NULL,
        current_version integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT halls_venue_name_key UNIQUE (venue_id, name),
        CONSTRAINT halls_size_check CHECK (width > 0 AND depth > 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX halls_organisation_id_idx ON halls (organisation_id)`);

    await queryRunner.query(`
      CREATE TABLE hall_floor_versions (
        hall_id uuid NOT NULL REFERENCES halls (id) ON DELETE CASCADE,
        version integer NOT NULL,
        floor jsonb NOT NULL,
        source varchar(16) NOT NULL,
        source_ref varchar(200),
        note varchar(300),
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (hall_id, version),
        CONSTRAINT hall_floor_versions_source_check
          CHECK (source IN ('blank', 'itpo', 'restore'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX hall_floor_versions_created_by_idx ON hall_floor_versions (created_by)`,
    );

    // Which record of a venue's own system (ITPO's hall 56, later its event-halls and stalls)
    // one of ours stands for. One-to-one in both directions, per organisation and system.
    await queryRunner.query(`
      CREATE TABLE external_refs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        system varchar(32) NOT NULL,
        entity_type varchar(32) NOT NULL,
        local_id uuid NOT NULL,
        external_id varchar(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT external_refs_external_key
          UNIQUE (organisation_id, system, entity_type, external_id),
        CONSTRAINT external_refs_local_key UNIQUE (organisation_id, system, entity_type, local_id)
      )
    `);
    await queryRunner.query(`CREATE INDEX external_refs_local_id_idx ON external_refs (local_id)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE external_refs`);
    await queryRunner.query(`DROP TABLE hall_floor_versions`);
    await queryRunner.query(`DROP TABLE halls`);
    await queryRunner.query(`DROP TABLE venues`);
  }
}
