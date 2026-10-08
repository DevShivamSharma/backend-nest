import { BookingMode, DEFAULT_FEATURES } from '../organisations/organisation-config';
import type { BookingStatus, PaymentStatus } from './booking.entity';
import {
  initialPaymentStatus,
  isActive,
  portalClosedReason,
  VenueBookingStatus,
  VenuePaymentStatus,
  venueReport,
} from './booking-rules';

const organisation = (exhibitorPortal: boolean, bookingMode: BookingMode) => ({
  features: { ...DEFAULT_FEATURES, exhibitorPortal },
  bookingMode,
});

const booking = (status: BookingStatus, paymentStatus: PaymentStatus | null) => ({
  status,
  paymentStatus,
});

const report = (bookingStatus: VenueBookingStatus, paymentStatus: VenuePaymentStatus) => ({
  bookingStatus,
  paymentStatus,
});

describe('booking rules', () => {
  it('counts held and confirmed bookings as active', () => {
    expect([
      isActive('held'),
      isActive('confirmed'),
      isActive('cancelled'),
      isActive('expired'),
    ]).toEqual([true, true, false, false]);
  });

  it('opens the portal only when switched on, and never in sync mode', () => {
    expect(portalClosedReason(organisation(true, BookingMode.OwnPortal))).toBeNull();
    expect(portalClosedReason(organisation(true, BookingMode.Embed))).toBeNull();
    expect(portalClosedReason(organisation(true, BookingMode.HybridHold))).toBeNull();
    expect(portalClosedReason(organisation(false, BookingMode.OwnPortal))).toMatch(
      /not switched on/,
    );
    expect(portalClosedReason(organisation(true, BookingMode.Sync))).toMatch(/own booking system/);
    expect(
      portalClosedReason({ features: undefined as never, bookingMode: BookingMode.OwnPortal }),
    ).toMatch(/not switched on/);
  });

  it('tracks payment only for a hold in hybrid_hold mode', () => {
    expect(initialPaymentStatus(BookingMode.HybridHold, 'held')).toBe('pending');
    expect(initialPaymentStatus(BookingMode.HybridHold, 'confirmed')).toBeNull();
    expect(initialPaymentStatus(BookingMode.OwnPortal, 'held')).toBeNull();
    expect(initialPaymentStatus(BookingMode.Embed, 'held')).toBeNull();
    expect(initialPaymentStatus(BookingMode.Sync, 'held')).toBeNull();
  });
});

describe('venueReport', () => {
  it('ignores a booking whose payment is not tracked here', () => {
    expect(venueReport(booking('held', null), report('Confirmed', 'Completed'))).toEqual({
      status: 'held',
      paymentStatus: null,
      outcome: 'ignored:not_tracked',
    });
  });

  it('never revives a cancelled or expired booking', () => {
    expect(venueReport(booking('cancelled', 'pending'), report('Confirmed', 'Completed'))).toEqual({
      status: 'cancelled',
      paymentStatus: 'pending',
      outcome: 'ignored:cancelled',
    });
    expect(venueReport(booking('expired', 'timeout'), report('Confirmed', 'Completed'))).toEqual({
      status: 'expired',
      paymentStatus: 'timeout',
      outcome: 'ignored:expired',
    });
  });

  it('confirms only when the booking is Confirmed and the payment Completed', () => {
    expect(venueReport(booking('held', 'pending'), report('Confirmed', 'Completed'))).toEqual({
      status: 'confirmed',
      paymentStatus: 'completed',
      outcome: 'confirmed',
    });
    // Confirmed by staff before the payment came in: the payment is recorded now.
    expect(venueReport(booking('confirmed', 'pending'), report('Confirmed', 'Completed'))).toEqual({
      status: 'confirmed',
      paymentStatus: 'completed',
      outcome: 'confirmed',
    });
  });

  it('changes nothing on a repeated paid report', () => {
    expect(
      venueReport(booking('confirmed', 'completed'), report('Confirmed', 'Completed')),
    ).toEqual({ status: 'confirmed', paymentStatus: 'completed', outcome: 'unchanged' });
  });

  it('ends a held booking on a timeout or a cancellation', () => {
    expect(venueReport(booking('held', 'pending'), report('Timeout', 'Timeout'))).toEqual({
      status: 'expired',
      paymentStatus: 'timeout',
      outcome: 'expired',
    });
    expect(venueReport(booking('held', 'pending'), report('Pending', 'Timeout'))).toMatchObject({
      status: 'expired',
    });
    expect(venueReport(booking('held', 'pending'), report('Cancelled', 'Cancelled'))).toEqual({
      status: 'cancelled',
      paymentStatus: 'cancelled',
      outcome: 'cancelled',
    });
    expect(venueReport(booking('held', 'pending'), report('Cancelled', 'Pending'))).toMatchObject({
      status: 'cancelled',
    });
  });

  it('leaves a confirmed booking to staff on a timeout or a cancellation', () => {
    for (const r of [report('Timeout', 'Timeout'), report('Cancelled', 'Cancelled')]) {
      expect(venueReport(booking('confirmed', 'pending'), r)).toEqual({
        status: 'confirmed',
        paymentStatus: 'pending',
        outcome: 'ignored:confirmed',
      });
    }
  });

  it('moves nothing on Confirmed without Completed, or while still pending', () => {
    expect(venueReport(booking('held', 'pending'), report('Confirmed', 'Pending'))).toEqual({
      status: 'held',
      paymentStatus: 'pending',
      outcome: 'ignored:not_paid',
    });
    expect(venueReport(booking('held', 'pending'), report('Pending', 'Pending'))).toEqual({
      status: 'held',
      paymentStatus: 'pending',
      outcome: 'unchanged',
    });
    // Completed payment on a booking SelfCare has not confirmed: still not confirmed here.
    expect(venueReport(booking('held', 'pending'), report('Pending', 'Completed'))).toMatchObject({
      status: 'held',
      paymentStatus: 'pending',
    });
  });
});
