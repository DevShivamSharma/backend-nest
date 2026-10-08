import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { ExhibitorsController } from './exhibitors.controller';
import { ExhibitorsService } from './exhibitors.service';

/** Exhibitors: the companies that take stalls, and the events they are registered for. */
@Module({
  imports: [AccessModule, AuditModule, EventsModule],
  controllers: [ExhibitorsController],
  providers: [ExhibitorsService],
  exports: [ExhibitorsService],
})
export class ExhibitorsModule {}
