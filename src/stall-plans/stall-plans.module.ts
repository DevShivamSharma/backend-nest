import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { StallPlansController } from './stall-plans.controller';
import { StallPlansService } from './stall-plans.service';

/** Module E: zones, stalls and seats on the halls of an event, checked against their rules. */
@Module({
  imports: [AccessModule, AuditModule, EventsModule],
  controllers: [StallPlansController],
  providers: [StallPlansService],
})
export class StallPlansModule {}
