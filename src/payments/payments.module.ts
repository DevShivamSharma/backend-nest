import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { BookingsModule } from '../bookings/bookings.module';
import type { PaymentsConfig } from '../config/configuration';
import { EventsModule } from '../events/events.module';
import { MailModule } from '../mail/mail.module';
import { LogGateway } from './log-gateway';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway';
import { PaymentsService } from './payments.service';
import { RazorpayGateway } from './razorpay-gateway';
import { RefundWorker } from './refund.worker';

/** Payments for portal holds on the platform's Razorpay account, and their refunds. */
@Module({
  imports: [AccessModule, AuditModule, MailModule, EventsModule, BookingsModule],
  providers: [
    PaymentsService,
    RefundWorker,
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
  exports: [PaymentsService],
})
export class PaymentsModule {}
