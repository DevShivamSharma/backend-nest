import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import {
  AllowEventRoles,
  CurrentAccess,
  OrgAccess,
  RequirePermissions,
} from '../access/org-access.decorators';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { PlanDeliveriesService } from './plan-deliveries.service';
import type { PlanDeliveriesView } from './venue-system.views';

/**
 * The pushes of a hall's published plan to the venue system (docs/15 §4). Seeing needs
 * `layouts.view`; sending a failed one again needs `layouts.publish` and is the venue's team's.
 */
@OrgAccess('events.view', 'layouts.view')
@AllowEventRoles()
@Controller('orgs/:slug/events/:id/halls/:hallId/plan/deliveries')
export class PlanDeliveriesController {
  constructor(private readonly deliveries: PlanDeliveriesService) {}

  @Get()
  list(
    @CurrentAccess() access: OrgAccessContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<PlanDeliveriesView> {
    return this.deliveries.list(access, id, hallId);
  }

  @RequirePermissions('events.view', 'layouts.publish')
  @Post(':deliveryId/resend')
  @HttpCode(HttpStatus.OK)
  resend(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
  ): Promise<PlanDeliveriesView> {
    return this.deliveries.resend(access, id, hallId, deliveryId, user);
  }
}
