import { Module } from '@nestjs/common';

import { BookingsModule } from '../bookings/bookings.module';
import { OrganisationsModule } from '../organisations/organisations.module';
import { PublicEventsController } from './public-events.controller';
import { PublicEventsService } from './public-events.service';

/** The public, read-only view of an event and its stall map. */
@Module({
  imports: [OrganisationsModule, BookingsModule],
  controllers: [PublicEventsController],
  providers: [PublicEventsService],
})
export class PublicEventsModule {}
