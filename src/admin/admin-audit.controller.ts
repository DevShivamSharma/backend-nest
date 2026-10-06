import { Controller, Get, Query } from '@nestjs/common';

import { AuditQueryDto } from '../audit/audit-query.dto';
import { AuditLogView, AuditService } from '../audit/audit.service';
import { PlatformAdminOnly } from '../auth/guards/platform-admin.guard';
import type { Page } from '../common/pagination';

@PlatformAdminOnly()
@Controller('admin/audit')
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() query: AuditQueryDto): Promise<Page<AuditLogView>> {
    return this.audit.list(query);
  }
}
