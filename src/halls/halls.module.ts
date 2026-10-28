import { Module } from '@nestjs/common';

import { HallsController } from './controllers/halls.controller';
import { HallsService } from './services/halls.service';

@Module({
  controllers: [HallsController],
  providers: [HallsService],
})
export class HallsModule {}
