import type { BookingView } from '../bookings/booking.views';
import type { EventStatus } from '../events/event.entity';

/** What an exhibitor's own users see first: their company and the events they may book at. */
export interface PortalView {
  exhibitor: { id: string; name: string };
  /** Null while the organisation takes bookings online; otherwise why not. */
  closedReason: string | null;
  events: PortalEventView[];
}

export interface PortalEventView {
  id: string;
  name: string;
  status: EventStatus;
  startsOn: string;
  endsOn: string;
  organiserName: string | null;
  /** Null while its stalls can be held here; otherwise why not (portalClosedReason). */
  closedReason: string | null;
  halls: Array<{ hallId: string; name: string; published: boolean; freeStalls: number }>;
}

/** Razorpay Checkout's options from the server (M6). `keyId` null: the log transport. */
export interface CheckoutView {
  keyId: string | null;
  orderId: string;
  /** Paise, as Checkout takes it. */
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill: { name: string; email: string; contact: string };
  holdExpiresAt: string;
}

export interface PortalHoldView {
  booking: BookingView;
  /** Null in M5, for a free stall, or when the order could not be made (`paymentError`). */
  checkout: CheckoutView | null;
  paymentError: string | null;
}

export interface PaymentResultView {
  booking: BookingView;
  outcome: 'confirmed' | 'revived' | 'already_paid' | 'refunding' | 'pending';
}
