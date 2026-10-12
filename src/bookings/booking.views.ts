import type { EventStatus } from '../events/event.entity';
import type { StallSide } from '../rules/rule-engine';
import type { StallScheme } from '../stall-plans/stall-plan.entity';
import type { HallFloor } from '../venues/floor/hall-floor';
import type { BookingChannel, BookingStatus } from './booking.entity';

export interface BookingView {
  id: string;
  event: { id: string; name: string; status: EventStatus };
  /** The venue's hall, as the event's routes name it. */
  hall: { id: string; name: string };
  /** The stall's number is as it was when booked. */
  stall: { id: string; label: string };
  exhibitor: { id: string; name: string };
  channel: BookingChannel;
  status: BookingStatus;
  /** While held: when the hold runs out unless confirmed. */
  holdExpiresAt: string | null;
  /** The stall's published price when booked, in paise, before GST. */
  amountPaise: number;
  currency: string;
  priceReckoning: string;
  note: string | null;
  cancelReason: string | null;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
}

/** A stall of the published plan, as published. */
export interface PublishedStallView {
  /** The planner's stall id. */
  id: string;
  /** Island and stall number as ITPO writes them, e.g. "B-12". */
  label: string;
  islandNumber: string | null;
  stallNumber: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  openSides: StallSide[];
  scheme: StallScheme;
  isPremium: boolean;
  isBlocked: boolean;
  isActive: boolean;
  /** As published, in paise before GST; null when not for sale or unpriced. */
  price: { amountPaise: number; currency: string; reckoning: string } | null;
}

/**
 * `free`: bookable; `held` / `booked`: an active booking has it; `not_for_sale`: blocked,
 * inactive or unpriced.
 */
export type StallState = 'free' | 'held' | 'booked' | 'not_for_sale';

export interface MapStallView extends PublishedStallView {
  state: StallState;
  booking: { id: string; exhibitorId: string; exhibitor: string; status: BookingStatus } | null;
}

/** A hall's published stalls with which are free, on the floor the event is drawn on. */
export interface StallMapView {
  event: { id: string; name: string; status: EventStatus };
  hall: { id: string; name: string; floorVersion: number };
  /** Null while no plan of the hall is published. */
  published: { revision: number; at: string } | null;
  /** Whether stalls of this hall can be booked now; `closedReason` says why not. */
  bookable: boolean;
  closedReason: string | null;
  floor: HallFloor;
  stalls: MapStallView[];
}
