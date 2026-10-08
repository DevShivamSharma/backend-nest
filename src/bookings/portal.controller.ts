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

import { CurrentAccess, OrgAccess } from '../access/org-access.decorators';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import type { BookingView, PortalView, StallMapView } from './booking.views';
import { BookingsService } from './bookings.service';
import { PortalBookingDto, PortalCancelDto } from './dto/booking.dto';

/**
 * The exhibitor portal (external booking): an exhibitor's own users, holding `stalls.book`, see
 * their events and stall maps, hold free stalls for their company and let go of their holds.
 * The exhibitor comes from the membership's scope, never from the request.
 */
@OrgAccess('stalls.book')
@Controller('orgs/:slug/portal')
export class PortalController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  portal(@CurrentAccess() access: OrgAccessContext): Promise<PortalView> {
    return this.bookings.portal(access);
  }

  @Get('events/:eventId/halls/:hallId/stalls')
  stallMap(
    @CurrentAccess() access: OrgAccessContext,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<StallMapView> {
    return this.bookings.portalStallMap(access, eventId, hallId);
  }

  @Get('bookings')
  list(@CurrentAccess() access: OrgAccessContext): Promise<BookingView[]> {
    return this.bookings.portalList(access);
  }

  @Post('bookings')
  hold(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: PortalBookingDto,
  ): Promise<BookingView> {
    return this.bookings.portalHold(access, dto, user);
  }

  @Post('bookings/:bookingId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body() dto: PortalCancelDto,
  ): Promise<BookingView> {
    return this.bookings.portalCancel(access, bookingId, dto.reason ?? null, user);
  }
}
