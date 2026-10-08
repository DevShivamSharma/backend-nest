import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';

import { Public } from '../common/decorators/public.decorator';
import { VenueStatusDto } from './dto/booking.dto';
import { VenueSignatureGuard } from './venue-signature.guard';
import { VenueStatusService } from './venue-status.service';

/**
 * The venue booking system's status callback (proposed contract, docs/14). No user signs in:
 * the report is signed with the shared secret instead, and the route is absent until that
 * secret is configured.
 */
@Public()
@UseGuards(VenueSignatureGuard)
@Controller('integrations/venue-system')
export class VenueStatusController {
  constructor(private readonly venueStatus: VenueStatusService) {}

  @Post(':slug/booking-status')
  @HttpCode(HttpStatus.OK)
  receive(@Param('slug') slug: string, @Body() dto: VenueStatusDto): Promise<{ outcome: string }> {
    return this.venueStatus.receive(slug, dto);
  }
}
