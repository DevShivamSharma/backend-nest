import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { RulesModule } from '../rules/rules.module';
import { TeamModule } from '../team/team.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

/** Module D: events, the halls they use with each hall's rules, and their organisers. */
@Module({
  imports: [AccessModule, AuditModule, RulesModule, TeamModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
