import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';

import { CurrentAccess, OrgAccess, RequirePermissions } from '../access/org-access.decorators';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { PlanRevisionDto, SavePlanDto } from './dto/stall-plan.dto';
import type { EventPlanSummaryView, StallPlanView } from './stall-plan.views';
import { StallPlansService } from './stall-plans.service';

/**
 * Stall plans of an event's halls. Seeing needs `layouts.view` (drafts also one of edit,
 * approve or publish); drawing `layouts.edit`; approving `layouts.approve`; sending to booking
 * `layouts.publish`.
 */
@OrgAccess('layouts.view')
@Controller('orgs/:slug/events/:eventId')
export class StallPlansController {
  constructor(private readonly plans: StallPlansService) {}

  @Get('plans')
  summaries(
    @CurrentAccess() access: OrgAccessContext,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ): Promise<EventPlanSummaryView[]> {
    return this.plans.summaries(access, eventId);
  }

  @Get('halls/:hallId/plan')
  get(
    @CurrentAccess() access: OrgAccessContext,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<StallPlanView> {
    return this.plans.get(access, eventId, hallId);
  }

  @RequirePermissions('layouts.edit')
  @Put('halls/:hallId/plan')
  save(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: SavePlanDto,
  ): Promise<StallPlanView> {
    return this.plans.save(access, eventId, hallId, dto, user);
  }

  @RequirePermissions('layouts.edit')
  @Delete('halls/:hallId/plan')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<void> {
    return this.plans.remove(access, eventId, hallId, user);
  }

  @RequirePermissions('layouts.approve')
  @Post('halls/:hallId/plan/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: PlanRevisionDto,
  ): Promise<StallPlanView> {
    return this.plans.approve(access, eventId, hallId, dto.revision, user);
  }

  @RequirePermissions('layouts.publish')
  @Post('halls/:hallId/plan/publish')
  @HttpCode(HttpStatus.OK)
  publish(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: PlanRevisionDto,
  ): Promise<StallPlanView> {
    return this.plans.publish(access, eventId, hallId, dto.revision, user);
  }

  @RequirePermissions('layouts.edit')
  @Post('halls/:hallId/plan/reopen')
  @HttpCode(HttpStatus.OK)
  reopen(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: PlanRevisionDto,
  ): Promise<StallPlanView> {
    return this.plans.reopen(access, eventId, hallId, dto.revision, user);
  }
}
