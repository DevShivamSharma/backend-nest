import { JsonHallImportService } from './json-import/json-import.service';
import { FloorPlanController } from './floor-plan/floor-plan.controller';
import { FloorPlanService } from './floor-plan/floor-plan.service';
import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { HallsService } from './halls.service';
import { ItpoHallImportService } from './itpo-hall-import.service';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';

/** Module B: venues, halls, their floor history, and floor imports from venue systems. */
@Module({
  imports: [AccessModule, AuditModule],
  controllers: [VenuesController],
  providers: [VenuesService, HallsService, ItpoHallImportService],
  exports: [HallsService],
})
export class VenuesModule {}
