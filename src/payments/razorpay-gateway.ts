import {
  GatewayError,
  type GatewayPayment,
  type GatewayRefund,
  type PaymentGateway,
} from './payment-gateway';

const API = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 15_000;

/** Razorpay's payment entity, as the API and webhooks give it (fields we read). */
export interface RazorpayPaymentEntity {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
  method?: string | null;
  fee?: number | null;
  error_description?: string | null;
}

export interface RazorpayRefundEntity {
  id: string;
  payment_id: string;
  amount: number;
  status: string;
  /** What we sent with it; `refundId` is our row's id. */
  notes?: Record<string, string> | null;
}

export interface RazorpayWebhook {
  event: string;
  payload: {
    payment?: { entity: RazorpayPaymentEntity };
    refund?: { entity: RazorpayRefundEntity };
  };
}

export function toGatewayPayment(p: RazorpayPaymentEntity): GatewayPayment {
  return {
    orderId: p.order_id,
    paymentId: p.id,
    amountPaise: p.amount,
    currency: p.currency,
    method: p.method ?? null,
    feePaise: p.fee ?? null,
    status: p.status as GatewayPayment['status'],
    raw: p as unknown as Record<string, unknown>,
  };
}

/** Razorpay over native `fetch` with Basic auth; the same shape as the assistant's provider calls. */
export class RazorpayGateway implements PaymentGateway {
  readonly provider = 'razorpay' as const;
  private readonly basic: string;

  constructor(
    readonly keyId: string,
    keySecret: string,
  ) {
    // Built once; the secret itself is never kept in a field that could be logged.
    this.basic = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  }

  async createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<{ orderId: string }> {
    const body = await this.call<{ id: string }>('POST', '/orders', {
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes,
    });
    return { orderId: body.id };
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    const body = await this.call<RazorpayPaymentEntity>(
      'GET',
      `/payments/${encodeURIComponent(paymentId)}`,
    );
    return toGatewayPayment(body);
  }

  async fetchOrderPayments(orderId: string): Promise<GatewayPayment[]> {
    // Razorpay answers with a collection: `{ entity: 'collection', count, items }`.
    const body = await this.call<{ items?: RazorpayPaymentEntity[] }>(
      'GET',
      `/orders/${encodeURIComponent(orderId)}/payments`,
    );
    return (body.items ?? []).map(toGatewayPayment);
  }

  async refund(input: {
    paymentId: string;
    amountPaise: number;
    notes: Record<string, string>;
  }): Promise<GatewayRefund> {
    const body = await this.call<RazorpayRefundEntity>(
      'POST',
      `/payments/${encodeURIComponent(input.paymentId)}/refund`,
      { amount: input.amountPaise, notes: input.notes },
    );
    return { refundId: body.id, status: body.status as GatewayRefund['status'] };
  }

  async fetchRefund(refundId: string): Promise<GatewayRefund> {
    const body = await this.call<RazorpayRefundEntity>(
      'GET',
      `/refunds/${encodeURIComponent(refundId)}`,
    );
    return { refundId: body.id, status: body.status as GatewayRefund['status'] };
  }

  /** A JSON call with a timeout; a non-2xx answer is a GatewayError naming only its status. */
  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers: {
          authorization: `Basic ${this.basic}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // No answer (timeout, network): a failure to retry later, not a refusal.
      throw new GatewayError(null, err instanceof Error ? err.name : 'no answer from Razorpay');
    }
    if (!response.ok) {
      // Razorpay's error text names the problem, never the key.
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new GatewayError(response.status, detail);
    }
    return (await response.json()) as T;
  }
}
