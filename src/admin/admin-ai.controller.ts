import { Controller, Get } from '@nestjs/common';

import { PlanTextReaderService } from '../ai/plan-text-reader.service';
import { PlatformAdminOnly } from '../auth/guards/platform-admin.guard';

/** Whether the local open-source models that read floor plans are ready. */
@PlatformAdminOnly()
@Controller('admin/ai')
export class AdminAiController {
  constructor(private readonly reader: PlanTextReaderService) {}

  @Get('status')
  status(): ReturnType<PlanTextReaderService['status']> {
    return this.reader.status();
  }
}
