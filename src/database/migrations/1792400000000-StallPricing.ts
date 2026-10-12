import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stall pricing, as ITPO keeps it: an event hall's rate card per price type (General, Premium,
 * Marquee) with bare and shell rates per m², open-side percentages, a catalogue charge and a
 * food & beverage price; and prices set on single stalls, which come first.
 */
export class StallPricing1792400000000 implements MigrationInterface {
  name = 'StallPricing1792400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE stall_price_cards (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_hall_id uuid NOT NULL REFERENCES event_halls (id) ON DELETE CASCADE,
        type varchar(16) NOT NULL CHECK (type IN ('general', 'premium', 'marquee')),
        bare_rate numeric(12, 2) NOT NULL CHECK (bare_rate >= 0),
        shell_rate numeric(12, 2) NOT NULL CHECK (shell_rate >= 0),
        side2_percent numeric(6, 2) NOT NULL DEFAULT 0 CHECK (side2_percent BETWEEN 0 AND 1000),
        side3_percent numeric(6, 2) NOT NULL DEFAULT 0 CHECK (side3_percent BETWEEN 0 AND 1000),
        side4_percent numeric(6, 2) NOT NULL DEFAULT 0 CHECK (side4_percent BETWEEN 0 AND 1000),
        catalogue_charge numeric(12, 2) NOT NULL DEFAULT 0 CHECK (catalogue_charge >= 0),
        fnb_price numeric(12, 2) CHECK (fnb_price >= 0),
        updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (event_hall_id, type)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX stall_price_cards_updated_by_idx ON stall_price_cards (updated_by)`,
    );
    await queryRunner.query(`
      CREATE TABLE stall_prices (
        event_hall_id uuid NOT NULL REFERENCES event_halls (id) ON DELETE CASCADE,
        stall_id uuid NOT NULL,
        price numeric(12, 2) NOT NULL CHECK (price >= 0),
        note varchar(300),
        updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (event_hall_id, stall_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX stall_prices_updated_by_idx ON stall_prices (updated_by)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE stall_prices`);
    await queryRunner.query(`DROP TABLE stall_price_cards`);
  }
}
