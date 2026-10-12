import { Controller, HttpCode, HttpStatus, NotFoundException, Param, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/http/authenticated-request';
import type { PaymentsConfig } from '../config/configuration';
import { PaymentsTransport } from '../config/env.validation';
import { PaymentsService } from './payments.service';

/**
 * The log transport's stand-in for Checkout (development and end-to-end tests): pays an order in
 * full as a signed-in user. Answers 404 under any other transport.
 */
@Controller('dev/payments')
export class DevPaymentsController {
  private readonly transport: PaymentsTransport;

  constructor(
    private readonly payments: PaymentsService,
    config: ConfigService,
  ) {
    this.transport = config.getOrThrow<PaymentsConfig>('payments').transport;
  }

  @Post(':orderId/pay')
  @HttpCode(HttpStatus.OK)
  async pay(
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
  ): Promise<{ outcome: string }> {
    if (this.transport !== PaymentsTransport.Log) throw new NotFoundException();
    return { outcome: await this.payments.devPay(orderId, user) };
  }
}
