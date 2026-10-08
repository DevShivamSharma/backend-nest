import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { ExhibitorsModule } from '../exhibitors/exhibitors.module';
import { StallPlansModule } from '../stall-plans/stall-plans.module';
import { VenuesModule } from '../venues/venues.module';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { PortalController } from './portal.controller';
import { VenueSignatureGuard } from './venue-signature.guard';
import { VenueStatusController } from './venue-status.controller';
import { VenueStatusService } from './venue-status.service';

/**
 * Stall bookings: internal ones by staff, external holds through the exhibitor portal, and the
 * venue booking system's signed status reports.
 */
@Module({
  imports: [
    AccessModule,
    AuditModule,
    EventsModule,
    ExhibitorsModule,
    StallPlansModule,
    VenuesModule,
  ],
  controllers: [BookingsController, PortalController, VenueStatusController],
  providers: [BookingsService, VenueStatusService, VenueSignatureGuard],
})
export class BookingsModule {}
