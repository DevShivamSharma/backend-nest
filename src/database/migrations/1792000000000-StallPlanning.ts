import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module E, stall planning: the organisation's stall categories, the categories each event
 * hall sells, and the plan of an event hall (zones, stalls and seats), in metres of the floor
 * the event is drawn on.
 *
 * A stall keeps what ITPO's `T_STALLS` keeps, so a plan can be pushed there: island and stall
 * number, open sides, categories and the stall's flags. Its shape is a rectangle on the floor's
 * axes, as the rules check it; ITPO's 1 m cells are made from it when pushed.
 */
export class StallPlanning1792000000000 implements MigrationInterface {
  name = 'StallPlanning1792000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE stall_categories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        name varchar(80) NOT NULL,
        status varchar(8) NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT stall_categories_status_check CHECK (status IN ('active', 'inactive'))
      )
    `);
    // One name once per organisation, whatever its case.
    await queryRunner.query(
      `CREATE UNIQUE INDEX stall_categories_name_key
        ON stall_categories (organisation_id, lower(name))`,
    );

    await queryRunner.query(`
      CREATE TABLE event_hall_categories (
        event_hall_id uuid NOT NULL REFERENCES event_halls (id) ON DELETE CASCADE,
        category_id uuid NOT NULL REFERENCES stall_categories (id),
        PRIMARY KEY (event_hall_id, category_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX event_hall_categories_category_idx ON event_hall_categories (category_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE stall_plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_hall_id uuid NOT NULL UNIQUE REFERENCES event_halls (id) ON DELETE CASCADE,
        revision integer NOT NULL DEFAULT 0,
        updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX stall_plans_updated_by_idx ON stall_plans (updated_by)`);

    // Ids of zones, stalls and seats come from the planner, so they stay the same across saves.
    await queryRunner.query(`
      CREATE TABLE plan_zones (
        id uuid PRIMARY KEY,
        plan_id uuid NOT NULL REFERENCES stall_plans (id) ON DELETE CASCADE,
        name varchar(80) NOT NULL,
        color varchar(9) NOT NULL,
        polygon jsonb NOT NULL,
        area double precision NOT NULL,
        sort_order integer NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX plan_zones_plan_idx ON plan_zones (plan_id)`);

    await queryRunner.query(`
      CREATE TABLE plan_stalls (
        id uuid PRIMARY KEY,
        plan_id uuid NOT NULL REFERENCES stall_plans (id) ON DELETE CASCADE,
        zone_id uuid REFERENCES plan_zones (id) ON DELETE SET NULL,
        island_number varchar(40),
        stall_number varchar(20) NOT NULL,
        x double precision NOT NULL,
        y double precision NOT NULL,
        width double precision NOT NULL,
        depth double precision NOT NULL,
        open_sides text[] NOT NULL DEFAULT '{}',
        scheme varchar(8) NOT NULL DEFAULT 'shell',
        category_ids uuid[] NOT NULL DEFAULT '{}',
        is_premium boolean NOT NULL DEFAULT false,
        is_blocked boolean NOT NULL DEFAULT false,
        is_fnb boolean NOT NULL DEFAULT false,
        is_branding boolean NOT NULL DEFAULT false,
        is_horseshoe boolean NOT NULL DEFAULT false,
        is_marquee_available boolean NOT NULL DEFAULT false,
        is_restricted_for_overseas boolean NOT NULL DEFAULT false,
        is_active boolean NOT NULL DEFAULT true,
        location varchar(200),
        description varchar(500),
        CONSTRAINT plan_stalls_scheme_check CHECK (scheme IN ('shell', 'raw')),
        CONSTRAINT plan_stalls_size_check CHECK (width > 0 AND depth > 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX plan_stalls_plan_idx ON plan_stalls (plan_id)`);
    await queryRunner.query(`CREATE INDEX plan_stalls_zone_idx ON plan_stalls (zone_id)`);
    // A stall's number (island and stall) once per plan.
    await queryRunner.query(
      `CREATE UNIQUE INDEX plan_stalls_number_key
        ON plan_stalls (plan_id, coalesce(island_number, ''), stall_number)`,
    );

    await queryRunner.query(`
      CREATE TABLE plan_seats (
        id uuid PRIMARY KEY,
        plan_id uuid NOT NULL REFERENCES stall_plans (id) ON DELETE CASCADE,
        zone_id uuid REFERENCES plan_zones (id) ON DELETE SET NULL,
        row_label varchar(4) NOT NULL,
        seat_number integer NOT NULL,
        x double precision NOT NULL,
        y double precision NOT NULL,
        width double precision NOT NULL,
        depth double precision NOT NULL,
        category_id uuid REFERENCES stall_categories (id),
        CONSTRAINT plan_seats_size_check CHECK (width > 0 AND depth > 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX plan_seats_plan_idx ON plan_seats (plan_id)`);
    await queryRunner.query(`CREATE INDEX plan_seats_zone_idx ON plan_seats (zone_id)`);
    await queryRunner.query(`CREATE INDEX plan_seats_category_idx ON plan_seats (category_id)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE plan_seats');
    await queryRunner.query('DROP TABLE plan_stalls');
    await queryRunner.query('DROP TABLE plan_zones');
    await queryRunner.query('DROP TABLE stall_plans');
    await queryRunner.query('DROP TABLE event_hall_categories');
    await queryRunner.query('DROP TABLE stall_categories');
  }
}
