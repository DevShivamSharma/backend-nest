import type { PaymentStatus } from '../payments/payment.entity';
import type { SettlementFigures } from './settlement-figures';
import type { SettlementStatus } from './settlement.entity';

export type SettlementViewStatus = 'open' | SettlementStatus;

export interface SettlementPaymentView {
  id: string;
  bookingId: string;
  stallLabel: string;
  exhibitorName: string;
  status: PaymentStatus;
  method: string | null;
  paidAt: string;
  amountPaise: number;
  feePaise: number | null;
  refundedPaise: number;
  pendingRefundPaise: number;
}

export interface SettlementView {
  eventId: string;
  status: SettlementViewStatus;
  /** Live while open; frozen at close. */
  figures: SettlementFigures;
  /** Payments whose gateway fee is unknown and counted as 0 (live, for a warning). */
  feeUnknown: number;
  /** Why it cannot be closed now; null when it can (also null once closed). */
  closeRefusal: string | null;
  closedAt: string | null;
  payout: { payeeName: string; bankDetails: string; reference: string; settledAt: string } | null;
  settledAt: string | null;
  payments: SettlementPaymentView[];
}
