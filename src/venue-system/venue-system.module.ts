import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import type { VenueSystemConfig } from '../config/configuration';
import { VenueCallbackTransport } from '../config/env.validation';
import { EventsModule } from '../events/events.module';
import { AdminVenueSystemController } from './admin-venue-system.controller';
import { OrgVenueSystemController } from './org-venue-system.controller';
import { PlanDeliveriesController } from './plan-deliveries.controller';
import { PlanDeliveriesService } from './plan-deliveries.service';
import { PlanDeliveryWorker } from './plan-delivery.worker';
import { VenueSystemService } from './venue-system.service';
import {
  HttpVenueTransport,
  LogVenueTransport,
  VENUE_TRANSPORT,
  type VenueTransport,
} from './venue-transport';

/**
 * An organisation's link to its own venue system, where published plans are pushed: the link,
 * the outbox of pushes and the worker that sends them.
 */
@Module({
  imports: [AccessModule, AuditModule, EventsModule],
  controllers: [AdminVenueSystemController, OrgVenueSystemController, PlanDeliveriesController],
  providers: [
    VenueSystemService,
    PlanDeliveriesService,
    PlanDeliveryWorker,
    {
      // The log transport unless VENUE_CALLBACK_TRANSPORT=http.
      provide: VENUE_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): VenueTransport => {
        const venue = config.getOrThrow<VenueSystemConfig>('venueSystem');
        return venue.transport === VenueCallbackTransport.Http
          ? new HttpVenueTransport(venue.timeoutMs)
          : new LogVenueTransport();
      },
    },
  ],
  exports: [PlanDeliveriesService],
})
export class VenueSystemModule {}
