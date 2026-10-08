import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { RulesModule } from '../rules/rules.module';
import { VenuesModule } from '../venues/venues.module';
import { StallPlansController } from './stall-plans.controller';
import { StallPlansService } from './stall-plans.service';

/** Stall plans: the stalls of an event's halls, checked against the rules, sent to booking. */
@Module({
  imports: [AccessModule, AuditModule, EventsModule, RulesModule, VenuesModule],
  controllers: [StallPlansController],
  providers: [StallPlansService],
  exports: [StallPlansService],
})
export class StallPlansModule {}
