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
import { CheckPlanDto, PublishPlanDto, RejectPlanDto, SavePlanDto } from './dto/stall-plans.dto';
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

  /** Internal events: the venue's team. External: the organiser, once the saved revision is approved. */
  @RequirePermissions('events.view', 'layouts.publish')
  @Post('publish')
  @HttpCode(HttpStatus.OK)
  publish(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: PublishPlanDto,
  ): Promise<StallPlanView> {
    return this.plans.publish(access, id, hallId, dto, user);
  }

  /** External events: the organiser sends the saved plan to the venue for approval. */
  @RequirePermissions('events.view', 'layouts.publish')
  @Post('submit')
  @HttpCode(HttpStatus.OK)
  submit(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: PublishPlanDto,
  ): Promise<StallPlanView> {
    return this.plans.submit(access, id, hallId, dto, user);
  }

  /** The organiser takes back a plan that waits for approval. */
  @RequirePermissions('events.view', 'layouts.edit')
  @Post('withdraw')
  @HttpCode(HttpStatus.OK)
  withdraw(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<StallPlanView> {
    return this.plans.withdraw(access, id, hallId, user);
  }

  /** The venue approves the plan that waits; the organiser then publishes it. */
  @RequirePermissions('events.view', 'layouts.approve')
  @Post('approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: PublishPlanDto,
  ): Promise<StallPlanView> {
    return this.plans.review(access, id, hallId, dto, true, user);
  }

  /** The venue sends the plan that waits back to the organiser, saying what to change. */
  @RequirePermissions('events.view', 'layouts.approve')
  @Post('reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: RejectPlanDto,
  ): Promise<StallPlanView> {
    return this.plans.review(access, id, hallId, dto, false, user);
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
