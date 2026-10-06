import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';

import { Public } from '../common/decorators/public.decorator';
import { OrganisationsService } from './organisations.service';
import { PublicConfigView, toPublicConfig } from './organisation.views';

/**
 * Turns a link's slug into the organisation's name and look, before anyone signs in. An old
 * slug answers with the current one, so the app can move the browser there. Unknown and
 * suspended organisations are indistinguishable: both are 404.
 */
@Public()
@Controller('orgs/:slug/public-config')
export class PublicConfigController {
  constructor(private readonly organisations: OrganisationsService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  async get(@Param('slug') slug: string): Promise<PublicConfigView> {
    const organisation = slug.length <= 40 ? await this.organisations.resolvePublic(slug) : null;
    if (!organisation) {
      throw new NotFoundException('This link does not lead to an organisation.');
    }
    return toPublicConfig(organisation);
  }
}
