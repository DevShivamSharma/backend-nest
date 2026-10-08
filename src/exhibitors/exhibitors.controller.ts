import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { CurrentAccess, OrgAccess, RequirePermissions } from '../access/org-access.decorators';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { CreateExhibitorDto, ListExhibitorsQuery, UpdateExhibitorDto } from './dto/exhibitor.dto';
import type { ExhibitorView } from './exhibitor.views';
import { ExhibitorsService } from './exhibitors.service';

/**
 * Exhibitors and their event registrations. No permission of their own exists: exhibitors are
 * the parties of bookings, so seeing them needs `bookings.view` and changing them
 * `bookings.manage` (the organiser admin's "exhibitors for the halls its event booked").
 */
@OrgAccess('bookings.view')
@Controller('orgs/:slug')
export class ExhibitorsController {
  constructor(private readonly exhibitors: ExhibitorsService) {}

  @Get('exhibitors')
  list(
    @CurrentAccess() access: OrgAccessContext,
    @Query() query: ListExhibitorsQuery,
  ): Promise<ExhibitorView[]> {
    return this.exhibitors.list(access, query);
  }

  @RequirePermissions('bookings.manage')
  @Post('exhibitors')
  create(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateExhibitorDto,
  ): Promise<ExhibitorView> {
    return this.exhibitors.create(access, dto, user);
  }

  @Get('exhibitors/:exhibitorId')
  get(
    @CurrentAccess() access: OrgAccessContext,
    @Param('exhibitorId', ParseUUIDPipe) exhibitorId: string,
  ): Promise<ExhibitorView> {
    return this.exhibitors.get(access, exhibitorId);
  }

  @RequirePermissions('bookings.manage')
  @Patch('exhibitors/:exhibitorId')
  update(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('exhibitorId', ParseUUIDPipe) exhibitorId: string,
    @Body() dto: UpdateExhibitorDto,
  ): Promise<ExhibitorView> {
    return this.exhibitors.update(access, exhibitorId, dto, user);
  }

  @RequirePermissions('bookings.manage')
  @Delete('exhibitors/:exhibitorId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('exhibitorId', ParseUUIDPipe) exhibitorId: string,
  ): Promise<void> {
    return this.exhibitors.remove(access, exhibitorId, user);
  }

  @RequirePermissions('bookings.manage')
  @Put('events/:eventId/exhibitors/:exhibitorId')
  register(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('exhibitorId', ParseUUIDPipe) exhibitorId: string,
  ): Promise<ExhibitorView> {
    return this.exhibitors.register(access, eventId, exhibitorId, user);
  }

  @RequirePermissions('bookings.manage')
  @Delete('events/:eventId/exhibitors/:exhibitorId')
  @HttpCode(HttpStatus.NO_CONTENT)
  unregister(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('exhibitorId', ParseUUIDPipe) exhibitorId: string,
  ): Promise<void> {
    return this.exhibitors.unregister(access, eventId, exhibitorId, user);
  }
}
