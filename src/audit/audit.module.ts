import { Global, Module } from '@nestjs/common';

import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/** The audit trail: any module may record into it; ITPO staff read it. */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
