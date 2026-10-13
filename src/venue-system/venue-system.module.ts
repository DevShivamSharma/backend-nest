import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AdminVenueSystemController } from './admin-venue-system.controller';
import { OrgVenueSystemController } from './org-venue-system.controller';
import { VenueSystemService } from './venue-system.service';

/** An organisation's link to its own venue system, where published plans are pushed. */
@Module({
  imports: [AccessModule, AuditModule],
  controllers: [AdminVenueSystemController, OrgVenueSystemController],
  providers: [VenueSystemService],
})
export class VenueSystemModule {}
