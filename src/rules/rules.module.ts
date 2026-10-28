import { Module } from '@nestjs/common';

import {
  EventRulesController,
  HallRulesController,
  RulesController,
} from './controllers/rules.controller';
import { RulesService } from './services/rules.service';

@Module({
  controllers: [RulesController, EventRulesController, HallRulesController],
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
