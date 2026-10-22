import { Module } from '@nestjs/common';

import { AccessModule } from '../../access/access.module';
import { AuditModule } from '../../audit/audit.module';
import { EventsModule } from '../../events/events.module';
import { RulesModule } from '../../rules/rules.module';
import { VenuesModule } from '../../venues/venues.module';
import { ItpoEventsController } from './itpo-events.controller';
import { ItpoEventsService } from './itpo-events.service';

/** ITPO's own events and halls, read from its tables and mirrored here for planning. */
@Module({
  imports: [AccessModule, AuditModule, EventsModule, RulesModule, VenuesModule],
  controllers: [ItpoEventsController],
  providers: [ItpoEventsService],
  exports: [ItpoEventsService],
})
export class ItpoModule {}
