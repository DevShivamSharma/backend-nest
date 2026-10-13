import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';

import type { AppConfig } from '../config/configuration';
import { Environment } from '../config/env.validation';
import { PlanDeliveriesService } from './plan-deliveries.service';

/** How often due plan deliveries are sent: every 30 seconds. */
const EVERY_MS = 30_000;

/**
 * Sends due plan deliveries every 30 seconds, in each API instance; `PlanDeliveriesService.sendDue`
 * claims each row with `SKIP LOCKED` and marks it `sending` before the venue is called, so
 * several instances never send the same delivery at once. Idle in tests, which call `sendDue`
 * themselves so nothing changes under them on a timer.
 */
@Injectable()
export class PlanDeliveryWorker {
  private readonly logger = new Logger(PlanDeliveryWorker.name);
  private readonly enabled: boolean;

  constructor(
    private readonly deliveries: PlanDeliveriesService,
    config: ConfigService,
  ) {
    this.enabled = config.getOrThrow<AppConfig>('app').env !== Environment.Test;
  }

  @Interval(EVERY_MS)
  async tick(): Promise<void> {
    if (!this.enabled) return;
    try {
      const n = await this.deliveries.sendDue();
      if (n > 0) {
        this.logger.log(`Sent ${n} plan ${n === 1 ? 'delivery' : 'deliveries'}.`);
      }
    } catch (error) {
      // The database may be away for a moment; the next tick tries again.
      this.logger.error(
        `Could not send plan deliveries: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
