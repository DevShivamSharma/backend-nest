import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';

import { PlatformAdminOnly } from '../auth/guards/platform-admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/http/authenticated-request';
import { VenueIntegrationDto } from './dto/venue-system.dto';
import { VenueSystemService } from './venue-system.service';
import type { VenueIntegrationView } from './venue-system.views';

/** The Super Admin links an organisation to its venue system (docs/15 §3.1). */
@PlatformAdminOnly()
@Controller('admin/organisations/:id/integration')
export class AdminVenueSystemController {
  constructor(private readonly venueSystem: VenueSystemService) {}

  @Get()
  get(@Param('id', ParseUUIDPipe) id: string): Promise<VenueIntegrationView> {
    return this.venueSystem.view(id);
  }

  @Put()
  put(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VenueIntegrationDto,
  ): Promise<VenueIntegrationView> {
    return this.venueSystem.save(id, dto, user);
  }
}
