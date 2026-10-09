import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';

import {
  AllowEventRoles,
  CurrentAccess,
  OrgAccess,
  RequirePermissions,
} from '../access/org-access.decorators';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { CheckPlanDto, SavePlanDto } from './dto/stall-plans.dto';
import { StallPlansService } from './stall-plans.service';
import type { PlanCheckView, PlannerView, StallPlanView } from './stall-plans.views';

/**
 * The stall plan of a hall of an event (Module E). Seeing needs `layouts.view`; drawing needs
 * `layouts.edit`, and the event's kind decides whose team draws. Organisers reach their own
 * events only.
 */
@OrgAccess('events.view', 'layouts.view')
@AllowEventRoles()
@Controller('orgs/:slug/events/:id/halls/:hallId/plan')
export class StallPlansController {
  constructor(private readonly plans: StallPlansService) {}

  @Get()
  get(
    @CurrentAccess() access: OrgAccessContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<PlannerView> {
    return this.plans.get(access, id, hallId);
  }

  @RequirePermissions('events.view', 'layouts.edit')
  @Post('check')
  @HttpCode(HttpStatus.OK)
  check(
    @CurrentAccess() access: OrgAccessContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: CheckPlanDto,
  ): Promise<PlanCheckView> {
    return this.plans.check(access, id, hallId, dto);
  }

  @RequirePermissions('events.view', 'layouts.edit')
  @Put()
  save(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: SavePlanDto,
  ): Promise<StallPlanView> {
    return this.plans.save(access, id, hallId, dto, user);
  }
}
