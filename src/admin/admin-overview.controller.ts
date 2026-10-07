import { Controller, Get } from '@nestjs/common';

import { PlatformAdminOnly } from '../auth/guards/platform-admin.guard';
import { AdminOverview, AdminOverviewService } from './admin-overview.service';

@PlatformAdminOnly()
@Controller('admin/overview')
export class AdminOverviewController {
  constructor(private readonly overview: AdminOverviewService) {}

  @Get()
  get(): Promise<AdminOverview> {
    return this.overview.overview();
  }
}
