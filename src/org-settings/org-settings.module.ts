import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { OrgSettingsController } from './org-settings.controller';

@Module({
  imports: [AccessModule, AuditModule],
  controllers: [OrgSettingsController],
})
export class OrgSettingsModule {}
