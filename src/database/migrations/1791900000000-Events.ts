import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module D, events: an event of the organisation (internal, or external for an organiser that
 * booked halls), the halls it uses, and for each hall the floor version and rules it is drawn
 * with.
 */
export class Events1791900000000 implements MigrationInterface {
  name = 'Events1791900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        kind varchar(16) NOT NULL,
        name varchar(160) NOT NULL,
        venue_event_id varchar(80),
        organiser_name varchar(160),
        audience varchar(8) NOT NULL,
        starts_on date NOT NULL,
        ends_on date NOT NULL,
        build_up_on date,
        dismantle_on date,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT events_kind_check CHECK (kind IN ('internal', 'external')),
        CONSTRAINT events_audience_check CHECK (audience IN ('B2B', 'B2C')),
        CONSTRAINT events_dates_check CHECK (
          ends_on >= starts_on
          AND (build_up_on IS NULL OR build_up_on <= starts_on)
          AND (dismantle_on IS NULL OR dismantle_on >= ends_on)
        ),
        CONSTRAINT events_organiser_check CHECK (kind = 'internal' OR organiser_name IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX events_organisation_idx ON events (organisation_id, starts_on)`,
    );
    // The venue system's id for the event, once per organisation.
    await queryRunner.query(
      `CREATE UNIQUE INDEX events_venue_event_id_key ON events (organisation_id, venue_event_id)
        WHERE venue_event_id IS NOT NULL`,
    );
    await queryRunner.query(`CREATE INDEX events_created_by_idx ON events (created_by)`);

    await queryRunner.query(`
      CREATE TABLE event_halls (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
        hall_id uuid NOT NULL REFERENCES halls (id),
        floor_version integer NOT NULL,
        rule_switches jsonb NOT NULL DEFAULT '{}',
        rule_values jsonb NOT NULL DEFAULT '{}',
        drawing_profile varchar(40) NOT NULL DEFAULT 'free',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT event_halls_event_hall_key UNIQUE (event_id, hall_id),
        CONSTRAINT event_halls_floor_version_fkey FOREIGN KEY (hall_id, floor_version)
          REFERENCES hall_floor_versions (hall_id, version)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX event_halls_hall_idx ON event_halls (hall_id, floor_version)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE event_halls');
    await queryRunner.query('DROP TABLE events');
  }
}
