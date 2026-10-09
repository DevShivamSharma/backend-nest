import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { StallPlansModule } from '../stall-plans/stall-plans.module';
import { AiService } from './ai.service';
import { AssistantController } from './assistant.controller';

/** The planner's AI assistant, answered by the model the environment names. */
@Module({
  imports: [AccessModule, StallPlansModule],
  controllers: [AssistantController],
  providers: [AiService],
})
export class AiModule {}
