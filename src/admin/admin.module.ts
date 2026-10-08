import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { TeamModule } from '../team/team.module';
import { AdminAuditController } from './admin-audit.controller';
import { AdminOrganisationsController } from './admin-organisations.controller';
import { AdminOverviewController } from './admin-overview.controller';
import { AdminOverviewService } from './admin-overview.service';
import { AdminRolesController } from './admin-roles.controller';

/** The Super Admin console's API, under /api/admin. */
@Module({
  imports: [AccessModule, TeamModule, AuditModule],
  controllers: [
    AdminOverviewController,
    AdminOrganisationsController,
    AdminRolesController,
    AdminAuditController,
  ],
  providers: [AdminOverviewService],
})
export class AdminModule {}
