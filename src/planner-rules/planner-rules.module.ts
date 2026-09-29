import { Module } from '@nestjs/common';
import { PlannerRuleController } from './planner-rule.controller';
import { PlannerRuleRepository } from './planner-rule.repository';
import { PlannerRuleService } from './planner-rule.service';

/** /api/planner-rules: stall-plotting rules per hall, stored in the database. */
@Module({
  controllers: [PlannerRuleController],
  providers: [PlannerRuleService, PlannerRuleRepository],
})
export class PlannerRulesModule {}
