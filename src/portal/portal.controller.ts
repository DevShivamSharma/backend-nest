import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import { AllowEventRoles, CurrentAccess, OrgAccess } from '../access/org-access.decorators';
import type { BookingView, StallMapView } from '../bookings/booking.views';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { PortalCancelDto, PortalHoldDto } from './dto/portal.dto';
import { PortalService } from './portal.service';
import type { PortalHoldView, PortalView } from './portal.views';

/**
 * The exhibitor portal (external booking): an exhibitor's own users, holding `stalls.book`, see
 * their events and stall maps, hold free stalls for their company and let go of their holds.
 * The exhibitor comes from the membership's scope, never from the request. The exhibitor role is
 * event-scoped, so the routes allow event roles.
 */
@OrgAccess('stalls.book')
@AllowEventRoles()
@Controller('orgs/:slug/portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get()
  overview(@CurrentAccess() access: OrgAccessContext): Promise<PortalView> {
    return this.portal.portal(access);
  }

  @Get('events/:eventId/halls/:hallId/stalls')
  stallMap(
    @CurrentAccess() access: OrgAccessContext,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<StallMapView> {
    return this.portal.stallMap(access, eventId, hallId);
  }

  @Get('bookings')
  list(@CurrentAccess() access: OrgAccessContext): Promise<BookingView[]> {
    return this.portal.bookings(access);
  }

  @Post('bookings')
  hold(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: PortalHoldDto,
  ): Promise<PortalHoldView> {
    return this.portal.hold(access, dto, user);
  }

  @Post('bookings/:bookingId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body() dto: PortalCancelDto,
  ): Promise<BookingView> {
    return this.portal.cancel(access, bookingId, dto, user);
  }
}
