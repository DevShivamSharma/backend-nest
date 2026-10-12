import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { ExhibitorsModule } from '../exhibitors/exhibitors.module';
import { BookingExpiryWorker } from './booking-expiry.worker';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

/** Stall bookings by staff, on the published plans of an organisation's events. */
@Module({
  imports: [AccessModule, AuditModule, EventsModule, ExhibitorsModule],
  controllers: [BookingsController],
  providers: [BookingsService, BookingExpiryWorker],
  exports: [BookingsService],
})
export class BookingsModule {}
