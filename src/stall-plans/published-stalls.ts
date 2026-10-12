import { forSale, PriceCard, stallPrice, StallPriceOverride } from './pricing/stall-price';
import type { PublishedStallEntity } from './stall-plan.entity';
import type { PlanStallView } from './stall-plans.views';

/** Every price is in Indian rupees for now (docs/15 §9 Q17). */
export const CURRENCY = 'INR';

/** A stall's full number, as ITPO writes it: island and stall, e.g. "12A-27 E". */
export function stallLabel(s: { islandNumber: string | null; stallNumber: string }): string {
  return s.islandNumber ? `${s.islandNumber}${s.stallNumber}` : s.stallNumber;
}

/**
 * The rows that publishing `revision` stores: each stall as saved, with its price as
 * `stallPrice()` works it out now. `stallPrice()` gives whole rupees; they are kept as integer
 * paise so money is never a float (docs/15 §3.4).
 */
export function publishedStallRows(
  eventHallId: string,
  revision: number,
  stalls: PlanStallView[],
  card: PriceCard | null,
  own: ReadonlyMap<string, StallPriceOverride>,
): PublishedStallEntity[] {
  return stalls.map((s) => {
    const price = stallPrice(s, card, own.get(s.id));
    return {
      eventHallId,
      stallId: s.id,
      publishedRevision: revision,
      zoneId: s.zoneId,
      islandNumber: s.islandNumber,
      stallNumber: s.stallNumber,
      x: s.x,
      y: s.y,
      width: s.width,
      depth: s.depth,
      openSides: s.openSides,
      scheme: s.scheme,
      categoryIds: s.categoryIds,
      isPremium: s.isPremium,
      isBlocked: s.isBlocked,
      isFnb: s.isFnb,
      isBranding: s.isBranding,
      isHorseshoe: s.isHorseshoe,
      isMarqueeAvailable: s.isMarqueeAvailable,
      isRestrictedForOverseas: s.isRestrictedForOverseas,
      isActive: s.isActive,
      location: s.location,
      description: s.description,
      pricePaise: price ? price.price * 100 : null,
      currency: price ? CURRENCY : null,
      priceReckoning: price ? price.reckoning : null,
    };
  });
}

/** An active booking on a stall of the hall, as the re-publish check needs it. */
export interface BookedStall {
  stallId: string;
  status: 'held' | 'confirmed';
  exhibitor: string;
}

const money = (paise: number | null): string =>
  paise === null ? 'no price' : `₹${(paise / 100).toLocaleString('en-IN')}`;

/**
 * What a re-publish would change about stalls with an active booking, one sentence each; empty
 * when nothing a booking relies on changes. A booked stall must stay in the plan, where it is
 * and as big (x, y, width, depth), for sale (not blocked, active), at the same price (paise and
 * currency) and with the same number (island and stall). Zone, categories, scheme, open sides,
 * flags, location and description may change, as long as the price stays the same.
 */
export function bookedStallChanges(
  current: readonly PublishedStallEntity[],
  next: readonly PublishedStallEntity[],
  booked: readonly BookedStall[],
): Array<{ stallId: string; message: string }> {
  const before = new Map(current.map((s) => [s.stallId, s]));
  const after = new Map(next.map((s) => [s.stallId, s]));
  const out: Array<{ stallId: string; message: string }> = [];
  for (const b of booked) {
    const was = before.get(b.stallId);
    // A booking is only ever made on a published stall; nothing to compare without one.
    if (!was) continue;
    const who = `${stallLabel(was)} (${b.exhibitor}, ${b.status})`;
    const say = (message: string) => out.push({ stallId: b.stallId, message });
    const now = after.get(b.stallId);
    if (!now) {
      say(`${who} is not in this version.`);
      continue;
    }
    if (now.x !== was.x || now.y !== was.y || now.width !== was.width || now.depth !== was.depth) {
      say(`${who} is moved or resized.`);
    }
    if (!forSale(now)) say(`${who} is taken off sale.`);
    if (now.pricePaise !== was.pricePaise || now.currency !== was.currency) {
      say(`${who}: its price changes from ${money(was.pricePaise)} to ${money(now.pricePaise)}.`);
    }
    if (stallLabel(now) !== stallLabel(was)) say(`${who} is renumbered ${stallLabel(now)}.`);
  }
  return out;
}