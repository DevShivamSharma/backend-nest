import { Controller, Get, Query } from '@nestjs/common';

import { AllowedUserTypes } from '../auth/decorators/user-types.decorator';
import { UserType } from '../auth/domain/user-type';
import { AUDIT_ACTIONS } from './audit-actions';
import { AuditQueryDto } from './dto/audit-query.dto';
import { AuditRow, AuditService } from './audit.service';

/** The audit trail, for ITPO staff. */
@AllowedUserTypes(UserType.ItpoStaff)
@Controller({ path: 'audit', version: '1' })
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** The actions the trail records, as the filter offers them. */
  @Get('actions')
  actions(): Array<{ id: string; label: string }> {
    return Object.entries(AUDIT_ACTIONS).map(([id, label]) => ({ id, label }));
  }

  @Get()
  list(@Query() query: AuditQueryDto): Promise<{
    items: AuditRow[];
    total: number;
    page: number;
    size: number;
  }> {
    return this.audit.list(query);
  }
}
