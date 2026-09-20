import { Module } from '@nestjs/common';

import { HallController } from './hall.controller';
import { HallRepository } from './hall.repository';
import { HallService } from './hall.service';

/** /api/halls — ported but deprecated (ADR-002). No known consumer. */
@Module({
  controllers: [HallController],
  providers: [HallService, HallRepository],
  exports: [HallService],
})
export class HallsModule {}
