import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The published plan as stored content (docs/15 §9 Q19, option a). Publishing copies the stalls
 * of the published revision here, each with the price it had then; a later save of the plan
 * changes `plan_stalls` only, so what is sold stays as published until the next publish replaces
 * it. Keyed by the planner's stall id, which a save keeps; the key leads with the event hall, so
 * it also serves the foreign key.
 */
export class PublishedStalls1792600000000 implements MigrationInterface {
  name = 'PublishedStalls1792600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE published_stalls (
        event_hall_id uuid NOT NULL REFERENCES event_halls (id) ON DELETE CASCADE,
        stall_id uuid NOT NULL,
        published_revision integer NOT NULL,
        zone_id uuid,
        island_number varchar(40),
        stall_number varchar(20) NOT NULL,
        x double precision NOT NULL,
        y double precision NOT NULL,
        width double precision NOT NULL,
        depth double precision NOT NULL,
        open_sides text[] NOT NULL DEFAULT '{}',
        scheme varchar(8) NOT NULL,
        category_ids uuid[] NOT NULL DEFAULT '{}',
        is_premium boolean NOT NULL,
        is_blocked boolean NOT NULL,
        is_fnb boolean NOT NULL,
        is_branding boolean NOT NULL,
        is_horseshoe boolean NOT NULL,
        is_marquee_available boolean NOT NULL,
        is_restricted_for_overseas boolean NOT NULL,
        is_active boolean NOT NULL,
        location varchar(200),
        description varchar(500),
        price_paise bigint,
        currency char(3),
        price_reckoning varchar(400),
        PRIMARY KEY (event_hall_id, stall_id),
        CONSTRAINT published_stalls_revision_check CHECK (published_revision >= 1),
        CONSTRAINT published_stalls_scheme_check CHECK (scheme IN ('shell', 'raw')),
        CONSTRAINT published_stalls_size_check CHECK (width > 0 AND depth > 0),
        CONSTRAINT published_stalls_price_check CHECK (
          (price_paise IS NULL) = (currency IS NULL)
          AND (price_paise IS NULL) = (price_reckoning IS NULL)
          AND (price_paise IS NULL OR price_paise >= 0)
        )
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE published_stalls`);
  }
}
