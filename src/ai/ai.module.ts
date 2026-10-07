import { Module } from '@nestjs/common';

import { OllamaClient } from './ollama.client';
import { PlanTextReaderService } from './plan-text-reader.service';

/** Reading floor plans with a local open-source model (Ollama), and the rules behind it. */
@Module({
  providers: [OllamaClient, PlanTextReaderService],
  exports: [PlanTextReaderService],
})
export class AiModule {}
