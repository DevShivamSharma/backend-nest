import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { VenuesModule } from '../venues/venues.module';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';

/** Module C: the organisation's rules and checking stalls against the rules. */
@Module({
  imports: [AccessModule, AuditModule, VenuesModule],
  controllers: [RulesController],
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
