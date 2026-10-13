import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { MailModule } from '../mail/mail.module';
import { VenueSystemModule } from '../venue-system/venue-system.module';
import { DrawingImportController } from './drawing-import/drawing-import.controller';
import { DrawingImportService } from './drawing-import/drawing-import.service';
import { PricingController } from './pricing/pricing.controller';
import { PricingService } from './pricing/pricing.service';
import { StallPlansController } from './stall-plans.controller';
import { StallPlansService } from './stall-plans.service';

/**
 * Module E: zones, stalls and seats on the halls of an event, checked against their rules; and
 * stalls read from a hall's CAD plan PDF for review.
 */
@Module({
  imports: [AccessModule, AuditModule, EventsModule, MailModule, VenueSystemModule],
  controllers: [StallPlansController, DrawingImportController, PricingController],
  providers: [StallPlansService, DrawingImportService, PricingService],
  exports: [StallPlansService],
})
export class StallPlansModule {}
