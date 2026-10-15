import type { EventStatus } from '../events/event.entity';
import type { OrganisationBranding } from '../organisations/organisation-config';
import type { StallSide } from '../rules/rule-engine';
import type { StallScheme } from '../stall-plans/stall-plan.entity';
import type { HallFloor } from '../venues/floor/hall-floor';

/** What anyone with the link sees of an event: no one's name, no booking, no account. */
export interface PublicEventView {
  /** Only what the public config already shows of the organisation. */
  organisation: { slug: string; name: string; branding: OrganisationBranding };
  event: {
    id: string;
    name: string;
    status: EventStatus;
    startsOn: string;
    endsOn: string;
    organiserName: string | null;
  };
  /** Halls whose plan is published; stalls for sale and how many of them are still free. */
  halls: Array<{
    hallId: string;
    name: string;
    width: number;
    depth: number;
    floorArea: number;
    totalStalls: number;
    freeStalls: number;
  }>;
  bookingOpen: boolean;
  /** Null while bookings are open; otherwise why not, in plain words. */
  closedReason: string | null;
  /** Where to write to be invited; the organisation's support address, if it has one. */
  contactEmail: string | null;
}

/**
 * `free`: can be booked; `unavailable`: held or booked (the public cannot tell which, nor by
 * whom); `not_for_sale`: blocked, inactive or unpriced.
 */
export type PublicStallState = 'free' | 'unavailable' | 'not_for_sale';

export interface PublicStallView {
  id: string;
  label: string;
  islandNumber: string | null;
  stallNumber: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  openSides: StallSide[];
  /** Cells cut out, [column, row] from the top-left. */
  cutCells: Array<[number, number]>;
  scheme: StallScheme;
  isPremium: boolean;
  isBlocked: boolean;
  isActive: boolean;
  /** In paise before GST; null when not for sale or unpriced. */
  price: { amountPaise: number; currency: string; reckoning: string } | null;
  state: PublicStallState;
}

/** A hall's published stalls as the public sees them, on the floor the event is drawn on. */
export interface PublicStallMapView {
  event: { id: string; name: string; status: EventStatus };
  hall: { id: string; name: string; floorVersion: number };
  bookingOpen: boolean;
  closedReason: string | null;
  floor: HallFloor;
  stalls: PublicStallView[];
}
