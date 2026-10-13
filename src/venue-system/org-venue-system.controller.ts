import { Controller, Get } from '@nestjs/common';

import { CurrentAccess, OrgAccess } from '../access/org-access.decorators';
import type { OrgAccessContext } from '../common/http/authenticated-request';
import { VenueSystemService } from './venue-system.service';
import type { VenueIntegrationView } from './venue-system.views';

/** What the organisation's members may see of the link: read-only, never the secret. */
@OrgAccess('org.settings.view')
@Controller('orgs/:slug/settings/integration')
export class OrgVenueSystemController {
  constructor(private readonly venueSystem: VenueSystemService) {}

  @Get()
  get(@CurrentAccess() access: OrgAccessContext): Promise<VenueIntegrationView> {
    return this.venueSystem.view(access.organisation.id);
  }
}
