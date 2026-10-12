import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Settlement (docs/15 §3.4, §6.3): what the platform owes the payee of a platform-portal event
 * once it is over. The figures are summed from payments and refunds while the event is open;
 * closing inserts the event's one row with the figures frozen, and recording the bank transfer
 * settles it. `platform_fee_percent` is the Super Admin's fee for the organisation (Q9), copied
 * onto the row at close so a later change does not alter a closed settlement.
 *
 * The row keeps its event with NO ACTION (an event with money is never deleted from under it);
 * an organisation delete still cascades. Amounts are integer paise.
 */
export class Settlements1792900000000 implements MigrationInterface {
  name = 'Settlements1792900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE organisations
        ADD COLUMN platform_fee_percent numeric(5,2) NOT NULL DEFAULT 0,
        ADD CONSTRAINT organisations_platform_fee_percent_check
          CHECK (platform_fee_percent >= 0 AND platform_fee_percent <= 100)
    `);
    await queryRunner.query(`
      CREATE TABLE settlements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        event_id uuid NOT NULL UNIQUE REFERENCES events (id),
        status varchar(16) NOT NULL,
        gross_paise bigint NOT NULL,
        refunded_paise bigint NOT NULL,
        gateway_fee_paise bigint NOT NULL,
        platform_fee_percent numeric(5,2) NOT NULL,
        platform_fee_paise bigint NOT NULL,
        net_payable_paise bigint NOT NULL,
        payee_name varchar(160),
        payee_bank_details varchar(1000),
        payout_reference varchar(120),
        closed_at timestamptz NOT NULL,
        closed_by uuid REFERENCES users (id) ON DELETE SET NULL,
        settled_at timestamptz,
        settled_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT settlements_status_check CHECK (
          status IN ('closing', 'settled')
          AND (status = 'settled') = (settled_at IS NOT NULL)
          AND (status = 'closing' OR net_payable_paise <= 0
               OR (payee_name IS NOT NULL AND payee_bank_details IS NOT NULL
                   AND payout_reference IS NOT NULL))
        ),
        CONSTRAINT settlements_amounts_check CHECK (
          gross_paise >= 0 AND refunded_paise >= 0 AND refunded_paise <= gross_paise
          AND gateway_fee_paise >= 0 AND platform_fee_paise >= 0
          AND net_payable_paise
              = gross_paise - refunded_paise - gateway_fee_paise - platform_fee_paise
        ),
        CONSTRAINT settlements_platform_fee_percent_check
          CHECK (platform_fee_percent >= 0 AND platform_fee_percent <= 100)
      )
    `);
    await queryRunner.query(`CREATE INDEX settlements_organisation_idx ON settlements (organisation_id)`);
    await queryRunner.query(`CREATE INDEX settlements_closed_by_idx ON settlements (closed_by)`);
    await queryRunner.query(`CREATE INDEX settlements_settled_by_idx ON settlements (settled_by)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE settlements`);
    await queryRunner.query(`ALTER TABLE organisations DROP COLUMN platform_fee_percent`);
  }
}
