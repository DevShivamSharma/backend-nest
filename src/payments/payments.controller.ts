import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { AllowEventRoles, CurrentAccess, OrgAccess } from '../access/org-access.decorators';
import type { BookingView } from '../bookings/booking.views';
import { BookingsService } from '../bookings/bookings.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { RefundDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

/**
 * Staff refunds of paid bookings (docs/15 §6.2). The route allows event roles, so a member scoped
 * to events holding `payments.manage` reaches the bookings of those events only (the service checks).
 */
@OrgAccess('payments.manage')
@AllowEventRoles()
@Controller('orgs/:slug')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly bookings: BookingsService,
  ) {}

  @Post('bookings/:bookingId/refund')
  @HttpCode(HttpStatus.OK)
  async refund(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body() dto: RefundDto,
  ): Promise<BookingView> {
    await this.payments.refundBooking(access, bookingId, dto, user);
    return this.bookings.get(access, bookingId);
  }
}
