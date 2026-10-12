import type { EventStatus } from '../events/event.entity';
import { forSale } from '../stall-plans/pricing/stall-price';
import type { PublishedStallEntity } from '../stall-plans/stall-plan.entity';
import type { BookingStatus } from './booking.entity';
import type { StallState } from './booking.views';

/**
 * Booking rules with no database, so they are tested on their own and the service reads as the
 * rules it applies.
 */

export function isActive(status: BookingStatus): boolean {
  return status === 'held' || status === 'confirmed';
}

/** When a hold made at `now` runs out. */
export function holdEnds(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * Why the event's stalls are not booked now; null while they are. Only a scheduled event is on
 * sale: a draft is not yet, a completed or cancelled one no longer.
 */
export function eventClosedReason(event: { name: string; status: EventStatus }): string | null {
  switch (event.status) {
    case 'scheduled':
      return null;
    case 'draft':
      return `Stalls are booked once ${event.name} is scheduled; it is still a draft.`;
    case 'completed':
    case 'cancelled':
      return `${event.name} is ${event.status}; its stalls are no longer booked.`;
  }
}

type SaleFields = Pick<PublishedStallEntity, 'isBlocked' | 'isActive' | 'pricePaise'>;

/**
 * Why this published stall cannot be booked, the event aside; null when it can. A stall for
 * sale with no price is not booked: the booking copies its price, and money is never guessed.
 */
export function stallClosedReason(
  stall: SaleFields,
  label: string,
  active: BookingStatus | null,
): string | null {
  if (!forSale(stall)) return `Stall ${label} is not for sale.`;
  if (stall.pricePaise === null) {
    return `Stall ${label} has no price. Price it, then publish the plan again.`;
  }
  if (active) return `Stall ${label} is already ${active === 'held' ? 'held' : 'booked'}.`;
  return null;
}

/** How the stall map shows a stall, given its active booking's status, if any. */
export function stallState(stall: SaleFields, active: BookingStatus | null): StallState {
  if (active === 'held') return 'held';
  if (active === 'confirmed') return 'booked';
  return forSale(stall) && stall.pricePaise !== null ? 'free' : 'not_for_sale';
}