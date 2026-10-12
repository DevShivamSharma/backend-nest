import { PriceCard, stallPrice, StallPriceOverride } from './pricing/stall-price';
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
