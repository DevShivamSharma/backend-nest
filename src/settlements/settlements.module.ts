import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';

/** What the platform owes the payee of a platform-portal event once it is over. */
@Module({
  imports: [AccessModule, AuditModule, EventsModule],
  controllers: [SettlementsController],
  providers: [SettlementsService],
})
export class SettlementsModule {}
