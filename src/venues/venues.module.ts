import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AiModule } from '../ai/ai.module';
import { AuditModule } from '../audit/audit.module';
import { PlanImportService } from './plan-import/plan-import.service';
import { HallsService } from './halls.service';
import { ItpoHallImportService } from './itpo-hall-import.service';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';

/** Module B: venues, halls, their floor history, and floor imports from venue systems. */
@Module({
  imports: [AccessModule, AuditModule, AiModule],
  controllers: [VenuesController],
  providers: [VenuesService, HallsService, ItpoHallImportService, PlanImportService],
  exports: [HallsService],
})
export class VenuesModule {}
