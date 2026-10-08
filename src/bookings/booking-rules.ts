import { BookingMode, OrganisationFeatures } from '../organisations/organisation-config';
import type { BookingStatus, PaymentStatus } from './booking.entity';

/**
 * Booking rules with no database: who may hold a stall through the portal, what a new booking's
 * payment starts as, and what a venue system's status report does to a booking.
 */

export function isActive(status: BookingStatus): boolean {
  return status === 'held' || status === 'confirmed';
}

/**
 * Exhibitors hold stalls themselves only when the Super Admin turned the exhibitor portal on,
 * and not in `sync` mode, where they book in the venue's own system. Null when open, else why not.
 */
export function portalClosedReason(organisation: {
  features: OrganisationFeatures;
  bookingMode: BookingMode;
}): string | null {
  if (!organisation.features?.exhibitorPortal) {
    return 'Stall booking by exhibitors is not switched on for this organisation.';
  }
  if (organisation.bookingMode === BookingMode.Sync) {
    return "Stalls of this organisation are booked in the venue's own booking system.";
  }
  return null;
}

/**
 * In `hybrid_hold` the venue's system takes the payment for a held stall, so a hold starts with
 * its payment `pending`. Everywhere else this platform does not track payment (null).
 */
export function initialPaymentStatus(
  mode: BookingMode,
  status: BookingStatus,
): PaymentStatus | null {
  return mode === BookingMode.HybridHold && status === 'held' ? 'pending' : null;
}

/** SelfCare's words for a booking and its payment, as its status report carries them. */
export const VENUE_BOOKING_STATUSES = ['Pending', 'Confirmed', 'Timeout', 'Cancelled'] as const;
export type VenueBookingStatus = (typeof VENUE_BOOKING_STATUSES)[number];
export const VENUE_PAYMENT_STATUSES = ['Pending', 'Completed', 'Timeout', 'Cancelled'] as const;
export type VenuePaymentStatus = (typeof VENUE_PAYMENT_STATUSES)[number];

export interface VenueReportResult {
  status: BookingStatus;
  paymentStatus: PaymentStatus | null;
  /** What the report did, stored with the delivery: `confirmed`, `unchanged`, `ignored:…`. */
  outcome: string;
}

/**
 * What a venue system's report does to one booking. Conservative on purpose:
 *  - only bookings whose payment this platform tracks are touched;
 *  - a cancelled or expired booking is never revived;
 *  - a booking is confirmed only when the booking is `Confirmed` AND the payment `Completed`;
 *  - a timeout or cancellation ends a held booking, never a confirmed one (staff decide that).
 */
export function venueReport(
  booking: { status: BookingStatus; paymentStatus: PaymentStatus | null },
  report: { bookingStatus: VenueBookingStatus; paymentStatus: VenuePaymentStatus },
): VenueReportResult {
  const keep = (outcome: string): VenueReportResult => ({
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    outcome,
  });
  if (booking.paymentStatus === null) return keep('ignored:not_tracked');
  if (!isActive(booking.status)) return keep(`ignored:${booking.status}`);

  const paid = report.bookingStatus === 'Confirmed' && report.paymentStatus === 'Completed';
  if (paid) {
    if (booking.status === 'confirmed' && booking.paymentStatus === 'completed') {
      return keep('unchanged');
    }
    return { status: 'confirmed', paymentStatus: 'completed', outcome: 'confirmed' };
  }

  const timedOut = report.bookingStatus === 'Timeout' || report.paymentStatus === 'Timeout';
  const cancelled = report.bookingStatus === 'Cancelled' || report.paymentStatus === 'Cancelled';
  if (timedOut || cancelled) {
    if (booking.status === 'confirmed') return keep('ignored:confirmed');
    return timedOut
      ? { status: 'expired', paymentStatus: 'timeout', outcome: 'expired' }
      : { status: 'cancelled', paymentStatus: 'cancelled', outcome: 'cancelled' };
  }

  // Still pending, or a contradiction (Confirmed without Completed): nothing moves.
  return keep(report.bookingStatus === 'Pending' ? 'unchanged' : 'ignored:not_paid');
}
