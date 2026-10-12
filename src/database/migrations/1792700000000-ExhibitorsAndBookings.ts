import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Exhibitors and stall bookings (docs/15 §3.3, ported from `@feature/rules` and retargeted):
 * where an event's stalls are sold, the companies that take stalls, the events they are
 * registered for, and their bookings of stalls of a published plan.
 *
 * A booking names its stall by event hall and the planner's stall id, the key of
 * `published_stalls`, with no foreign key to it: a re-publish replaces those rows, and a
 * cancelled booking must not keep a dropped stall alive. The publish check keeps active
 * bookings on stalls that exist. Its other foreign keys are NO ACTION, so a direct delete of a
 * booked event, hall or registration is refused while an organisation delete still cascades;
 * the services refuse first, in words.
 */
export class ExhibitorsAndBookings1792700000000 implements MigrationInterface {
  name = 'ExhibitorsAndBookings1792700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // docs/15 §2 decision 3. Internal events would sell through the venue's system once an
    // integration exists (M1); none does, so every event sells on the platform's portal.
    await queryRunner.query(`
      ALTER TABLE events
        ADD COLUMN booking_channel varchar(16) NOT NULL DEFAULT 'platform_portal',
        ADD CONSTRAINT events_booking_channel_check
          CHECK (booking_channel IN ('venue_system', 'platform_portal'))
    `);

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
    // A name once per organisation, whatever its case. Also serves the organisation_id key.
    await queryRunner.query(
      `CREATE UNIQUE INDEX exhibitors_organisation_name_key
         ON exhibitors (organisation_id, lower(name))`,
    );

    await queryRunner.query(`
      CREATE TABLE event_exhibitors (
        event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
        exhibitor_id uuid NOT NULL REFERENCES exhibitors (id),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (event_id, exhibitor_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX event_exhibitors_exhibitor_idx ON event_exhibitors (exhibitor_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE bookings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        event_id uuid NOT NULL REFERENCES events (id),
        event_hall_id uuid NOT NULL REFERENCES event_halls (id),
        stall_id uuid NOT NULL,
        stall_label varchar(60) NOT NULL,
        exhibitor_id uuid NOT NULL,
        channel varchar(16) NOT NULL,
        status varchar(16) NOT NULL,
        hold_expires_at timestamptz,
        amount_paise bigint NOT NULL,
        currency char(3) NOT NULL,
        price_reckoning varchar(400) NOT NULL,
        note varchar(500),
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        confirmed_at timestamptz,
        confirmed_by uuid REFERENCES users (id) ON DELETE SET NULL,
        cancelled_at timestamptz,
        cancelled_by uuid REFERENCES users (id) ON DELETE SET NULL,
        cancel_reason varchar(500),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT bookings_event_exhibitor_fkey FOREIGN KEY (event_id, exhibitor_id)
          REFERENCES event_exhibitors (event_id, exhibitor_id),
        CONSTRAINT bookings_channel_check CHECK (channel IN ('internal', 'external')),
        CONSTRAINT bookings_status_check CHECK (
          status IN ('held', 'confirmed', 'cancelled', 'expired')
          AND (status <> 'held' OR hold_expires_at IS NOT NULL)
          AND (status <> 'confirmed' OR (confirmed_at IS NOT NULL AND hold_expires_at IS NULL))
          AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
          AND (cancel_reason IS NULL OR status = 'cancelled')
        ),
        CONSTRAINT bookings_amount_check CHECK (amount_paise >= 0)
      )
    `);
    // One active booking per stall: two writers racing for it, the second gets a conflict.
    await queryRunner.query(
      `CREATE UNIQUE INDEX bookings_active_stall_key ON bookings (event_hall_id, stall_id)
         WHERE status IN ('held', 'confirmed')`,
    );
    await queryRunner.query(
      `CREATE INDEX bookings_event_idx ON bookings (event_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX bookings_event_hall_idx ON bookings (event_hall_id, stall_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX bookings_event_exhibitor_idx ON bookings (event_id, exhibitor_id)`,
    );
    await queryRunner.query(`CREATE INDEX bookings_organisation_idx ON bookings (organisation_id)`);
    // The hold-expiry worker's scan: held bookings by when they run out.
    await queryRunner.query(
      `CREATE INDEX bookings_hold_expiry_idx ON bookings (hold_expires_at) WHERE status = 'held'`,
    );
    await queryRunner.query(`CREATE INDEX bookings_created_by_idx ON bookings (created_by)`);
    await queryRunner.query(`CREATE INDEX bookings_confirmed_by_idx ON bookings (confirmed_by)`);
    await queryRunner.query(`CREATE INDEX bookings_cancelled_by_idx ON bookings (cancelled_by)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE bookings`);
    await queryRunner.query(`DROP TABLE event_exhibitors`);
    await queryRunner.query(`DROP TABLE exhibitors`);
    await queryRunner.query(`
      ALTER TABLE events
        DROP CONSTRAINT events_booking_channel_check,
        DROP COLUMN booking_channel
    `);
  }
}
