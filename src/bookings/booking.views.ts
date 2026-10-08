import type { EventStatus } from '../events/event.entity';
import type { BookingMode } from '../organisations/organisation-config';
import type { EventType } from '../rules/rule-catalogue';
import type { StallSide } from '../rules/rule-engine';
import type { StallType } from '../stall-plans/stall-plan.entity';
import type { StallView } from '../stall-plans/stall-plan.views';
import type { HallFloor } from '../venues/floor/hall-floor';
import type { BookingChannel, BookingStatus, PaymentStatus } from './booking.entity';

export interface BookingView {
  id: string;
  event: { id: string; name: string; status: EventStatus };
  hall: { id: string; name: string };
  stall: {
    id: string;
    number: string;
    area: number;
    openSides: StallSide[];
    stallType: StallType | null;
  };
  exhibitor: { id: string; name: string };
  channel: BookingChannel;
  status: BookingStatus;
  /** Null: payment is not tracked on this platform (see `PaymentStatus`). */
  paymentStatus: PaymentStatus | null;
  note: string | null;
  externalRef: string | null;
  cancelReason: string | null;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
}

/** `free`: open for booking; `held` / `booked`: a held or confirmed booking has it. */
export type StallState = 'free' | 'held' | 'booked';

export interface MapStallView extends StallView {
  state: StallState;
  /**
   * The active booking on the stall. Staff see every booking and whose it is; an exhibitor sees
   * only its own (another exhibitor's stall shows as held or booked, without a name).
   */
  booking: { id: string; exhibitor: string; own: boolean } | null;
}

/** A published hall plan of an event, with which stalls are free. */
export interface StallMapView {
  event: { id: string; name: string; status: EventStatus; eventType: EventType };
  hall: { id: string; name: string; floorVersion: number };
  /** Bookable now: the event is scheduled (and, for exhibitors, the portal is open). */
  bookable: boolean;
  floor: HallFloor;
  stalls: MapStallView[];
}

/** What an exhibitor's user sees first: its company, its events, and whether it can book. */
export interface PortalView {
  exhibitor: { id: string; name: string };
  bookingMode: BookingMode;
  /** Null when exhibitors may hold stalls here; otherwise why they cannot. */
  closedReason: string | null;
  events: Array<{
    id: string;
    name: string;
    status: EventStatus;
    startsOn: string;
    endsOn: string;
    venue: string;
    halls: Array<{ hallId: string; name: string; published: boolean; freeStalls: number }>;
  }>;
}
