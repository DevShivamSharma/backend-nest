import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { BookingsModule } from '../bookings/bookings.module';
import { EventsModule } from '../events/events.module';
import { ExhibitorsModule } from '../exhibitors/exhibitors.module';
import { PaymentsModule } from '../payments/payments.module';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

/** The exhibitor portal: an exhibitor's own users see their events and hold stalls. */
@Module({
  imports: [AccessModule, EventsModule, ExhibitorsModule, BookingsModule, PaymentsModule],
  controllers: [PortalController],
  providers: [PortalService],
  exports: [PortalService],
})
export class PortalModule {}
