import { Module } from '@nestjs/common';

import { RulesModule } from '../rules/rules.module';
import { PlanOverviewController, StallPlansController } from './controllers/stall-plans.controller';
import { DrawingImportController } from './drawing-import/drawing-import.controller';
import { DrawingCheckService } from './drawing-import/drawing-check.service';
import { DrawingImportService } from './drawing-import/drawing-import.service';
import { PricingController } from './pricing/pricing.controller';
import { RateCardService } from './pricing/rate-card.service';
import { PlanNotificationsService } from './services/plan-notifications.service';
import { PlanContextService } from './services/plan-context.service';
import { StallPlansService } from './services/stall-plans.service';

@Module({
  imports: [RulesModule],
  controllers: [
    StallPlansController,
    PlanOverviewController,
    DrawingImportController,
    PricingController,
  ],
  providers: [
    PlanContextService,
    StallPlansService,
    DrawingImportService,
    DrawingCheckService,
    RateCardService,
    PlanNotificationsService,
  ],
  exports: [StallPlansService],
})
export class StallPlansModule {}
