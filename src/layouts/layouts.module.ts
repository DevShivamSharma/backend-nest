import { Module } from '@nestjs/common';
import { PricingService } from '../pricing/pricing.service';
import { PriceMastersController, LayoutPricingController } from '../pricing/pricing.controller';

import { LayoutController } from './layout.controller';
import { LayoutRepository } from './layout.repository';
import { LayoutService } from './layout.service';
import { LayoutsController } from './layouts.controller';
import { SeedImportController } from './seed-import.controller';
import { StallTypesController } from './stall-types.controller';

@Module({
  controllers: [LayoutController, LayoutsController, SeedImportController, StallTypesController, PriceMastersController, LayoutPricingController],
  providers: [LayoutService, LayoutRepository, PricingService],
  exports: [LayoutService],
})
export class LayoutsModule {}
