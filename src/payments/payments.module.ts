import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { PaymentsConfig } from '../config/configuration';
import { LogGateway } from './log-gateway';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway';
import { RazorpayGateway } from './razorpay-gateway';

@Module({
  providers: [
    {
      // Razorpay when its keys are configured, else the log transport.
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PaymentGateway => {
        const payments = config.getOrThrow<PaymentsConfig>('payments');
        return payments.razorpay
          ? new RazorpayGateway(payments.razorpay.keyId, payments.razorpay.keySecret)
          : new LogGateway();
      },
    },
  ],
  exports: [PAYMENT_GATEWAY],
})
export class PaymentsModule {}
