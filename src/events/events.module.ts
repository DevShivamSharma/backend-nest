import { Module } from '@nestjs/common';

import { EventsController } from './controllers/events.controller';
import { EventsService } from './services/events.service';

@Module({
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
