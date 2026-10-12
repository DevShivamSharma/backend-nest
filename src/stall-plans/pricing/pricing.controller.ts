import { Body, Controller, Param, ParseUUIDPipe, Put } from '@nestjs/common';

import {
  AllowEventRoles,
  CurrentAccess,
  OrgAccess,
  RequirePermissions,
} from '../../access/org-access.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../../common/http/authenticated-request';
import { PriceCardDto, SetStallPricesDto } from './pricing.dto';
import { PricingService } from './pricing.service';
import type { PlanPricingView } from './pricing.views';

/**
 * The prices of an event hall's stalls: its rate card, and prices set on single stalls. Seen
 * with the plan (`pricing.view`); set with `pricing.manage` by the team the event's kind names.
 */
@OrgAccess('events.view', 'pricing.view')
@AllowEventRoles()
@Controller('orgs/:slug/events/:id/halls/:hallId/plan/pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @RequirePermissions('events.view', 'pricing.manage')
  @Put('card')
  setCard(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: PriceCardDto,
  ): Promise<PlanPricingView> {
    return this.pricing.setCard(access, id, hallId, dto, user);
  }

  @RequirePermissions('events.view', 'pricing.manage')
  @Put('stalls')
  setStallPrices(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: SetStallPricesDto,
  ): Promise<PlanPricingView> {
    return this.pricing.setStallPrices(access, id, hallId, dto, user);
  }
}
