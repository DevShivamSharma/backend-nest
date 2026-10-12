import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  GatewayError,
  type GatewayPayment,
  type GatewayRefund,
  type PaymentGateway,
} from './payment-gateway';

/**
 * The development transport: orders are made up and logged, nothing leaves the server. There is
 * no Checkout to pay them, so a development route marks an order paid instead.
 */
export class LogGateway implements PaymentGateway {
  readonly provider = 'log' as const;
  readonly keyId = null;
  private readonly logger = new Logger(LogGateway.name);

  async createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<{ orderId: string }> {
    const orderId = `order_log_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    this.logger.log(`Order ${orderId}: ${input.amountPaise} paise`);
    return { orderId };
  }

  async fetchPayment(): Promise<GatewayPayment> {
    throw new GatewayError(
      409,
      'The log transport has no Checkout; use the development payment route.',
    );
  }

  /** Nothing is ever paid behind the server's back: only the development route pays an order. */
  async fetchOrderPayments(): Promise<GatewayPayment[]> {
    return [];
  }

  async refund(): Promise<GatewayRefund> {
    const refundId = `rfnd_log_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    return { refundId, status: 'processed' };
  }

  async fetchRefund(refundId: string): Promise<GatewayRefund> {
    return { refundId, status: 'processed' };
  }
}
