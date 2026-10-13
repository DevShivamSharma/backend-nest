import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The link from an organisation to its own venue system (docs/15 §3.1, flow 1): where a
 * published plan is pushed and the secret it is signed with. One per organisation; the Super
 * Admin sets it. The secret is sealed (AES-256-GCM under INTEGRATION_SECRET_KEY), never hashed,
 * because each push signs with it. `secret_hint` is its last four characters, so people can tell
 * which secret is set without seeing it. ITPO's endpoint has no ping, so there are no ping columns.
 */
export class VenueSystemIntegrations1793000000000 implements MigrationInterface {
  name = 'VenueSystemIntegrations1793000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE venue_system_integrations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL UNIQUE REFERENCES organisations (id) ON DELETE CASCADE,
        callback_url varchar(500) NOT NULL,
        secret_sealed text NOT NULL,
        secret_hint varchar(8) NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT venue_system_integrations_url_check CHECK (callback_url ~ '^https?://'),
        CONSTRAINT venue_system_integrations_secret_check CHECK (secret_sealed LIKE 'v1:%')
      )
    `);
    await queryRunner.query(
      `CREATE INDEX venue_system_integrations_created_by_idx ON venue_system_integrations (created_by)`,
    );
    await queryRunner.query(
      `CREATE INDEX venue_system_integrations_updated_by_idx ON venue_system_integrations (updated_by)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE venue_system_integrations`);
  }
}
