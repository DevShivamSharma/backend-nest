import type { PaymentProvider } from './payment.entity';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** A payment the gateway reports as captured: money is ours. */
export interface CapturedPayment {
  orderId: string;
  paymentId: string;
  amountPaise: number;
  currency: string;
  method: string | null;
  feePaise: number | null;
  raw: Record<string, unknown>;
}

export interface GatewayPayment extends CapturedPayment {
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
}

export interface GatewayRefund {
  refundId: string;
  status: 'pending' | 'processed' | 'failed';
}

/** The few calls payments make; `log` for development, `razorpay` for real money. */
export interface PaymentGateway {
  readonly provider: PaymentProvider;
  /** For Checkout; null with the log transport (no Checkout, the dev route pays). */
  readonly keyId: string | null;
  createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<{ orderId: string }>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  /** Every attempt made against an order, whatever its status; the reconcile pass reads these. */
  fetchOrderPayments(orderId: string): Promise<GatewayPayment[]>;
  refund(input: {
    paymentId: string;
    amountPaise: number;
    notes: Record<string, string>;
  }): Promise<GatewayRefund>;
  fetchRefund(refundId: string): Promise<GatewayRefund>;
}

/** A refusal (4xx: do not retry the same call) or a failure (5xx, no answer: retry later). */
export class GatewayError extends Error {
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(status ? `HTTP ${status} ${detail}` : detail);
  }

  get refused(): boolean {
    return this.status !== null && this.status >= 400 && this.status < 500;
  }
}
