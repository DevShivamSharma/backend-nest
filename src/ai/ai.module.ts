import { Module } from '@nestjs/common';

import { StallPlansModule } from '../stall-plans/stall-plans.module';
import { AiService } from './ai.service';
import { AssistantController } from './assistant.controller';

/** The planner's AI assistant, answered by NVIDIA's model. */
@Module({
  imports: [StallPlansModule],
  controllers: [AssistantController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
