import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';

import type { AppConfig } from '../config/configuration';
import { Environment } from '../config/env.validation';
import { BookingsService } from './bookings.service';

/** How often held bookings past their time are expired (docs/15 §6.3: every minute). */
const EVERY_MS = 60_000;

/**
 * Expires held bookings whose time ran out, every minute, in each API instance; see
 * `BookingsService.expireHolds` for why several instances are safe. Idle in tests, which call
 * that method themselves so nothing changes under them on a timer (the throttler is off there
 * too).
 */
@Injectable()
export class BookingExpiryWorker {
  private readonly logger = new Logger(BookingExpiryWorker.name);
  private readonly enabled: boolean;

  constructor(
    private readonly bookings: BookingsService,
    config: ConfigService,
  ) {
    this.enabled = config.getOrThrow<AppConfig>('app').env !== Environment.Test;
  }

  @Interval(EVERY_MS)
  async tick(): Promise<void> {
    if (!this.enabled) return;
    try {
      const expired = await this.bookings.expireHolds();
      if (expired) {
        this.logger.log(`Expired ${expired} held ${expired === 1 ? 'booking' : 'bookings'}.`);
      }
    } catch (error) {
      // The database may be away for a moment; the next tick tries again.
      this.logger.error(
        `Could not expire holds: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}