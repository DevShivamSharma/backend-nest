import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payments (docs/15 §6): what an exhibitor pays for a booking, the webhook deliveries that
 * report it, and the refunds that give it back.
 *
 * `payments` is one Razorpay order (or a fake one with the log transport) for one booking; a
 * booking has at most one open order, which a retry reuses. `payment_events` records each
 * webhook delivery by its event id, so a redelivery is recognised and answered without being
 * applied twice. `refunds` is one refund request against a payment; a row is marked `sending`
 * and committed before the gateway is called, and is never resent from `sending` on its own.
 *
 * Payments keep their booking with NO ACTION, so a booking that was paid is never deleted out
 * from under its money; an organisation delete still cascades. Amounts are integer paise.
 */
export class Payments1792800000000 implements MigrationInterface {
  name = 'Payments1792800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        booking_id uuid NOT NULL REFERENCES bookings (id),
        provider varchar(16) NOT NULL,
        provider_order_id varchar(64) NOT NULL UNIQUE,
        provider_payment_id varchar(64) UNIQUE,
        amount_paise bigint NOT NULL,
        currency char(3) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'created',
        method varchar(32),
        fee_paise bigint,
        paid_at timestamptz,
        raw jsonb,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payments_provider_check CHECK (provider IN ('razorpay', 'log')),
        CONSTRAINT payments_status_check CHECK (
          status IN ('created', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded')
          AND (status IN ('created', 'failed', 'expired')
               OR (paid_at IS NOT NULL AND provider_payment_id IS NOT NULL))
        ),
        CONSTRAINT payments_amount_check CHECK (amount_paise > 0),
        CONSTRAINT payments_fee_check CHECK (fee_paise IS NULL OR fee_paise >= 0)
      )
    `);
    // One open order per booking: a retry reuses it; two racing "pay" clicks cannot make two.
    await queryRunner.query(
      `CREATE UNIQUE INDEX payments_open_booking_key ON payments (booking_id)
         WHERE status IN ('created', 'failed')`,
    );
    await queryRunner.query(
      `CREATE INDEX payments_booking_idx ON payments (booking_id, created_at DESC)`,
    );
    await queryRunner.query(`CREATE INDEX payments_organisation_idx ON payments (organisation_id)`);
    await queryRunner.query(`CREATE INDEX payments_created_by_idx ON payments (created_by)`);

    // Webhook deliveries, one row per Razorpay event id: a redelivery finds its row and stops.
    await queryRunner.query(`
      CREATE TABLE payment_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider varchar(16) NOT NULL,
        provider_event_id varchar(80) NOT NULL UNIQUE,
        event_type varchar(48) NOT NULL,
        payload jsonb NOT NULL,
        outcome varchar(32) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payment_events_provider_check CHECK (provider IN ('razorpay'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE refunds (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        payment_id uuid NOT NULL REFERENCES payments (id),
        amount_paise bigint NOT NULL,
        provider_refund_id varchar(64) UNIQUE,
        status varchar(16) NOT NULL DEFAULT 'requested',
        reason varchar(500) NOT NULL,
        failure varchar(300),
        requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
        requested_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT refunds_status_check CHECK (
          status IN ('requested', 'sending', 'processed', 'failed')
          AND (status = 'processed') = (processed_at IS NOT NULL)
          AND (failure IS NULL OR status = 'failed')
        ),
        CONSTRAINT refunds_amount_check CHECK (amount_paise > 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX refunds_payment_idx ON refunds (payment_id)`);
    // The refund worker's scan: refunds still to send. A refund left `sending` is never picked
    // up again here, since the gateway may already have it; it is reconciled by hand or webhook.
    await queryRunner.query(
      `CREATE INDEX refunds_requested_idx ON refunds (requested_at) WHERE status = 'requested'`,
    );
    await queryRunner.query(`CREATE INDEX refunds_organisation_idx ON refunds (organisation_id)`);
    await queryRunner.query(`CREATE INDEX refunds_requested_by_idx ON refunds (requested_by)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE refunds`);
    await queryRunner.query(`DROP TABLE payment_events`);
    await queryRunner.query(`DROP TABLE payments`);
  }
}
