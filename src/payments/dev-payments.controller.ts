import { Controller, HttpCode, HttpStatus, NotFoundException, Param, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/http/authenticated-request';
import type { AppConfig, PaymentsConfig } from '../config/configuration';
import { Environment, PaymentsTransport } from '../config/env.validation';
import { PaymentsService } from './payments.service';

/**
 * The log transport's stand-in for Checkout (development and end-to-end tests): pays an order in
 * full for the exhibitor it is for, or for staff who manage its bookings. Answers 404 under any
 * other transport, and always in production, whatever the transport: the boot check refuses the
 * log transport there, and this is the second lock on the same door.
 */
@Controller('dev/payments')
export class DevPaymentsController {
  private readonly enabled: boolean;

  constructor(
    private readonly payments: PaymentsService,
    config: ConfigService,
  ) {
    this.enabled =
      config.getOrThrow<PaymentsConfig>('payments').transport === PaymentsTransport.Log &&
      config.getOrThrow<AppConfig>('app').env !== Environment.Production;
  }

  @Post(':orderId/pay')
  @HttpCode(HttpStatus.OK)
  async pay(
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
  ): Promise<{ outcome: string }> {
    if (!this.enabled) throw new NotFoundException();
    return { outcome: await this.payments.devPay(orderId, user) };
  }
}
