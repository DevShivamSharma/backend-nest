import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Modules D onwards: events and the halls they book, exhibitors and their event registrations,
 * stall plans on an event's halls, stall bookings, and the deduplicated status reports a venue's
 * own booking system sends back.
 *
 * Foreign keys into the venues module are `ON DELETE RESTRICT`: a hall or floor version an
 * event uses cannot be deleted from under it. Every foreign key has an index (or leads one).
 */
export class EventsAndBookings1791900000000 implements MigrationInterface {
  name = 'EventsAndBookings1791900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        venue_id uuid NOT NULL REFERENCES venues (id) ON DELETE RESTRICT,
        name varchar(160) NOT NULL,
        code varchar(40),
        kind varchar(16) NOT NULL,
        event_type varchar(8) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'draft',
        starts_on date NOT NULL,
        ends_on date NOT NULL,
        organiser_name varchar(160),
        organiser_email varchar(254),
        organiser_phone varchar(32),
        description varchar(2000),
        cancelled_reason varchar(500),
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT events_kind_check CHECK (kind IN ('internal', 'external')),
        CONSTRAINT events_event_type_check CHECK (event_type IN ('B2B', 'B2C')),
        CONSTRAINT events_status_check
          CHECK (status IN ('draft', 'scheduled', 'completed', 'cancelled')),
        CONSTRAINT events_dates_check CHECK (ends_on >= starts_on),
        CONSTRAINT events_organiser_email_lower_check CHECK (organiser_email = lower(organiser_email))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX events_organisation_id_starts_on_idx ON events (organisation_id, starts_on)`,
    );
    await queryRunner.query(`CREATE INDEX events_venue_id_idx ON events (venue_id)`);
    await queryRunner.query(`CREATE INDEX events_created_by_idx ON events (created_by)`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX events_organisation_code_key ON events (organisation_id, lower(code))
         WHERE code IS NOT NULL`,
    );

    // The halls an event books, each on the floor version it was booked with.
    await queryRunner.query(`
      CREATE TABLE event_halls (
        event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
        hall_id uuid NOT NULL REFERENCES halls (id) ON DELETE RESTRICT,
        floor_version integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (event_id, hall_id),
        CONSTRAINT event_halls_floor_version_fkey FOREIGN KEY (hall_id, floor_version)
          REFERENCES hall_floor_versions (hall_id, version) ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE INDEX event_halls_hall_id_floor_version_idx ON event_halls (hall_id, floor_version)`,
    );

    await queryRunner.query(`
      CREATE TABLE exhibitors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        name varchar(160) NOT NULL,
        contact_name varchar(120),
        email varchar(254),
        phone varchar(32),
        gstin varchar(15),
        address varchar(300),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT exhibitors_email_lower_check CHECK (email = lower(email))
      )
    `);
    // Also serves the organisation_id foreign key.
    await queryRunner.query(
      `CREATE UNIQUE INDEX exhibitors_organisation_name_key ON exhibitors (organisation_id, lower(name))`,
    );

    await queryRunner.query(`
      CREATE TABLE event_exhibitors (
        event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
        exhibitor_id uuid NOT NULL REFERENCES exhibitors (id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (event_id, exhibitor_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX event_exhibitors_exhibitor_id_idx ON event_exhibitors (exhibitor_id)`,
    );

    // One stall plan per hall of an event, on that hall's pinned floor.
    await queryRunner.query(`
      CREATE TABLE stall_plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        event_id uuid NOT NULL,
        hall_id uuid NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'draft',
        revision integer NOT NULL DEFAULT 1,
        rule_overrides jsonb NOT NULL DEFAULT '[]',
        approved_by uuid REFERENCES users (id) ON DELETE SET NULL,
        approved_at timestamptz,
        published_by uuid REFERENCES users (id) ON DELETE SET NULL,
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT stall_plans_event_hall_key UNIQUE (event_id, hall_id),
        CONSTRAINT stall_plans_event_hall_fkey FOREIGN KEY (event_id, hall_id)
          REFERENCES event_halls (event_id, hall_id) ON DELETE RESTRICT,
        CONSTRAINT stall_plans_status_check CHECK (status IN ('draft', 'approved', 'published'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX stall_plans_organisation_id_idx ON stall_plans (organisation_id)`,
    );
    await queryRunner.query(`CREATE INDEX stall_plans_hall_id_idx ON stall_plans (hall_id)`);
    await queryRunner.query(
      `CREATE INDEX stall_plans_approved_by_idx ON stall_plans (approved_by)`,
    );
    await queryRunner.query(
      `CREATE INDEX stall_plans_published_by_idx ON stall_plans (published_by)`,
    );

    await queryRunner.query(`
      CREATE TABLE stalls (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        plan_id uuid NOT NULL REFERENCES stall_plans (id) ON DELETE CASCADE,
        number varchar(40) NOT NULL,
        x double precision NOT NULL,
        y double precision NOT NULL,
        width double precision NOT NULL,
        depth double precision NOT NULL,
        open_sides text[] NOT NULL DEFAULT '{}'::text[],
        stall_type varchar(8),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT stalls_plan_number_key UNIQUE (plan_id, number),
        CONSTRAINT stalls_size_check CHECK (width > 0 AND depth > 0),
        CONSTRAINT stalls_stall_type_check CHECK (stall_type IS NULL OR stall_type IN ('shell', 'bare'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE bookings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        event_id uuid NOT NULL,
        stall_id uuid NOT NULL REFERENCES stalls (id) ON DELETE RESTRICT,
        exhibitor_id uuid NOT NULL,
        channel varchar(16) NOT NULL,
        status varchar(16) NOT NULL,
        payment_status varchar(16),
        note varchar(500),
        external_ref varchar(80),
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        confirmed_by uuid REFERENCES users (id) ON DELETE SET NULL,
        confirmed_at timestamptz,
        cancelled_by uuid REFERENCES users (id) ON DELETE SET NULL,
        cancelled_at timestamptz,
        cancel_reason varchar(500),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT bookings_event_exhibitor_fkey FOREIGN KEY (event_id, exhibitor_id)
          REFERENCES event_exhibitors (event_id, exhibitor_id) ON DELETE RESTRICT,
        CONSTRAINT bookings_channel_check CHECK (channel IN ('internal', 'external')),
        CONSTRAINT bookings_status_check
          CHECK (status IN ('held', 'confirmed', 'cancelled', 'expired')),
        CONSTRAINT bookings_payment_status_check CHECK (
          payment_status IS NULL OR payment_status IN ('pending', 'completed', 'timeout', 'cancelled')
        )
      )
    `);
    // A stall has at most one active booking; two writers racing for it get a conflict.
    await queryRunner.query(
      `CREATE UNIQUE INDEX bookings_active_stall_key ON bookings (stall_id)
         WHERE status IN ('held', 'confirmed')`,
    );
    await queryRunner.query(`CREATE INDEX bookings_stall_id_idx ON bookings (stall_id)`);
    await queryRunner.query(
      `CREATE INDEX bookings_event_id_exhibitor_id_idx ON bookings (event_id, exhibitor_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX bookings_organisation_id_created_at_idx
         ON bookings (organisation_id, created_at DESC)`,
    );
    await queryRunner.query(`CREATE INDEX bookings_created_by_idx ON bookings (created_by)`);
    await queryRunner.query(`CREATE INDEX bookings_confirmed_by_idx ON bookings (confirmed_by)`);
    await queryRunner.query(`CREATE INDEX bookings_cancelled_by_idx ON bookings (cancelled_by)`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX bookings_external_ref_key ON bookings (organisation_id, external_ref)
         WHERE external_ref IS NOT NULL`,
    );

    // Status reports from a venue's booking system, kept once per delivery id.
    await queryRunner.query(`
      CREATE TABLE booking_status_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        delivery_id varchar(100) NOT NULL,
        booking_id uuid REFERENCES bookings (id) ON DELETE SET NULL,
        payload jsonb NOT NULL,
        outcome varchar(32) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT booking_status_deliveries_delivery_key UNIQUE (organisation_id, delivery_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX booking_status_deliveries_booking_id_idx ON booking_status_deliveries (booking_id)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE booking_status_deliveries`);
    await queryRunner.query(`DROP TABLE bookings`);
    await queryRunner.query(`DROP TABLE stalls`);
    await queryRunner.query(`DROP TABLE stall_plans`);
    await queryRunner.query(`DROP TABLE event_exhibitors`);
    await queryRunner.query(`DROP TABLE exhibitors`);
    await queryRunner.query(`DROP TABLE event_halls`);
    await queryRunner.query(`DROP TABLE events`);
  }
}
