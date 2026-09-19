import { Module } from '@nestjs/common';

import { LayoutController } from './layout.controller';
import { LayoutRepository } from './layout.repository';
import { LayoutService } from './layout.service';
import { LayoutsController } from './layouts.controller';

@Module({
  controllers: [LayoutController, LayoutsController],
  providers: [LayoutService, LayoutRepository],
  exports: [LayoutService],
})
export class LayoutsModule {}
