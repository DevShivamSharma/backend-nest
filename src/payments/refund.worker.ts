import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';

import type { AppConfig } from '../config/configuration';
import { Environment } from '../config/env.validation';
import { PaymentsService } from './payments.service';

/** How often requested refunds are sent (event cancels, retries): every minute. */
const EVERY_MS = 60_000;

/**
 * Sends requested refunds every minute, in each API instance; `PaymentsService.sendRefund`
 * claims each row with `SKIP LOCKED` and marks it `sending` before the gateway is called, so
 * several instances never send the same refund. Idle in tests, which call `sendDueRefunds`
 * themselves so nothing changes under them on a timer.
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
}
