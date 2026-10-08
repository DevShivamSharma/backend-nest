import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { VenuesModule } from '../venues/venues.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

/** Module D: events, the halls they book and who may see them. */
@Module({
  imports: [AccessModule, AuditModule, VenuesModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
