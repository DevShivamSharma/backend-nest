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
  Query,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

import {
  AllowEventRoles,
  CurrentAccess,
  OrgAccess,
  RequirePermissions,
} from '../../access/org-access.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../../common/http/authenticated-request';
import { Trim } from '../../common/validation';
import { EVENT_KINDS, type EventKind } from '../../events/event.entity';
import {
  ItpoEventDetailView,
  ItpoEventsService,
  ItpoEventView,
  ItpoHallView,
} from './itpo-events.service';

export class ItpoEventListQuery {
  @IsIn(EVENT_KINDS)
  kind!: EventKind;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  q?: string;
}

export class AddItpoEventHallDto {
  /** T_HALLS.id */
  @Matches(/^\d{1,9}$/, { message: 'hallId must be an ITPO hall id' })
  hallId!: string;

  @IsOptional()
  @IsBoolean()
  forStallFnb?: boolean;
}

export class ItpoHallCategoriesDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  categoryIds!: string[];
}

/**
 * ITPO's events, from its own tables: internal events for ITPO's admins, external events for
 * the admins (all) and organisers (their own). Opening one mirrors it here for planning.
 */
@OrgAccess('events.view')
@AllowEventRoles()
@Controller('orgs/:slug/itpo')
export class ItpoEventsController {
  constructor(private readonly events: ItpoEventsService) {}

  @Get('events')
  list(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Query() query: ItpoEventListQuery,
  ): Promise<ItpoEventView[]> {
    return this.events.list(access, user, query.kind, query.q);
  }

  @Get('events/:id')
  get(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<ItpoEventDetailView> {
    return this.events.get(access, user, id);
  }

  /** Mirrors the event here for planning; returns our event's id. */
  @Post('events/:id/open')
  @HttpCode(HttpStatus.OK)
  open(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ eventId: string }> {
    return this.events.open(access, user, id);
  }

  @RequirePermissions('events.manage')
  @Get('halls')
  halls(@CurrentAccess() access: OrgAccessContext): Promise<ItpoHallView[]> {
    return this.events.halls(access);
  }

  @RequirePermissions('events.manage')
  @Post('events/:id/halls')
  @HttpCode(HttpStatus.OK)
  addHall(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddItpoEventHallDto,
  ): Promise<ItpoEventDetailView> {
    return this.events.addHall(access, user, id, dto.hallId, dto.forStallFnb ?? false);
  }

  /** The categories an ITPO event's halls may sell; `id` is our event's. */
  @Get('mirrored/:eventId/categories')
  categoryOptions(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ): Promise<Array<{ id: string; name: string; status: 'active' }>> {
    return this.events.categoryOptions(access, user, eventId);
  }

  /** What a hall of an internal ITPO event sells, here and in ITPO. */
  @RequirePermissions('events.manage')
  @Put('mirrored/:eventId/halls/:hallId/categories')
  @HttpCode(HttpStatus.NO_CONTENT)
  setHallCategories(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: ItpoHallCategoriesDto,
  ): Promise<void> {
    return this.events.setHallCategories(access, user, eventId, hallId, dto.categoryIds);
  }
}
