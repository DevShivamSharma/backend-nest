import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';

import type { AppConfig } from '../config/configuration';
import { Environment } from '../config/env.validation';
import { PaymentsService } from './payments.service';

/** How often requested refunds are sent (event cancels, retries): every minute. */
const EVERY_MS = 60_000;
/** How often Razorpay is asked about what its webhooks never reported: every five minutes. */
const RECONCILE_EVERY_MS = 5 * 60_000;

/**
 * Sends requested refunds every minute, in each API instance; `PaymentsService.sendRefund`
 * claims each row with `SKIP LOCKED` and marks it `sending` before the gateway is called, so
 * several instances never send the same refund. Every five minutes it also reconciles with
 * Razorpay (`PaymentsService.reconcile`), so a lost webhook does not leave a paid stall unpaid or
 * a refund unsettled; settling is idempotent, so instances doing it together is safe. Idle in
 * tests, which call `sendDueRefunds` and `reconcile` themselves so nothing changes under them on
 * a timer.
 */
@Injectable()
export class RefundWorker {
  private readonly logger = new Logger(RefundWorker.name);
  private readonly enabled: boolean;

  constructor(
    private readonly payments: PaymentsService,
    config: ConfigService,
  ) {
    this.enabled = config.getOrThrow<AppConfig>('app').env !== Environment.Test;
  }

  @Interval(EVERY_MS)
  async tick(): Promise<void> {
    if (!this.enabled) return;
    try {
      const sent = await this.payments.sendDueRefunds();
      if (sent) {
        this.logger.log(`Sent or checked ${sent} ${sent === 1 ? 'refund' : 'refunds'}.`);
      }
    } catch (error) {
      // The database may be away for a moment; the next tick tries again.
      this.logger.error(
        `Could not send refunds: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  @Interval(RECONCILE_EVERY_MS)
  async reconcile(): Promise<void> {
    if (!this.enabled) return;
    try {
      const settled = await this.payments.reconcile();
      if (settled) {
        this.logger.log(
          `Settled ${settled} ${settled === 1 ? 'payment or refund' : 'payments and refunds'} Razorpay had not reported.`,
        );
      }
    } catch (error) {
      // The database may be away for a moment; the next pass tries again.
      this.logger.error(
        `Could not reconcile with Razorpay: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
