import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';

import {
  AllowEventRoles,
  CurrentAccess,
  OrgAccess,
  RequirePermissions,
} from '../access/org-access.decorators';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import type { BookingView, StallMapView } from './booking.views';
import { BookingsService } from './bookings.service';
import {
  CancelBookingDto,
  CreateBookingDto,
  ListBookingsQuery,
  MoveBookingDto,
} from './dto/booking.dto';

/**
 * Stall bookings as staff work them (internal channel). Seeing needs `bookings.view`; booking,
 * confirming, moving and cancelling `bookings.manage`. Organisers reach their own events only.
 */
@OrgAccess('bookings.view')
@AllowEventRoles()
@Controller('orgs/:slug')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get('bookings')
  list(
    @CurrentAccess() access: OrgAccessContext,
    @Query() query: ListBookingsQuery,
  ): Promise<BookingView[]> {
    return this.bookings.list(access, query);
  }

  @Get('bookings/:bookingId')
  get(
    @CurrentAccess() access: OrgAccessContext,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
  ): Promise<BookingView> {
    return this.bookings.get(access, bookingId);
  }

  @RequirePermissions('bookings.manage')
  @Post('bookings')
  create(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateBookingDto,
  ): Promise<BookingView> {
    return this.bookings.create(access, dto, user);
  }

  @RequirePermissions('bookings.manage')
  @Post('bookings/:bookingId/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
  ): Promise<BookingView> {
    return this.bookings.confirm(access, bookingId, user);
  }

  @RequirePermissions('bookings.manage')
  @Post('bookings/:bookingId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body() dto: CancelBookingDto,
  ): Promise<BookingView> {
    return this.bookings.cancel(access, bookingId, dto.reason, user);
  }

  @RequirePermissions('bookings.manage')
  @Post('bookings/:bookingId/move')
  @HttpCode(HttpStatus.OK)
  move(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body() dto: MoveBookingDto,
  ): Promise<BookingView> {
    return this.bookings.move(access, bookingId, dto, user);
  }

  /** A hall's published stalls and who holds which; read from the published snapshot only. */
  @Get('events/:eventId/halls/:hallId/stalls')
  stallMap(
    @CurrentAccess() access: OrgAccessContext,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<StallMapView> {
    return this.bookings.stallMap(access, eventId, hallId);
  }
}
