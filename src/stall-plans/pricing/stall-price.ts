/**
 * A stall's price, as ITPO works it out: the hall's rate card for the stall's type (General,
 * Premium or Marquee), area × the bare or shell rate, more for each open side past the first,
 * and the catalogue entry charge; a food & beverage stall has its own price. A price set on the
 * stall itself comes before all of that. Rupees, before GST; no foreign currency yet.
 *
 * The same reckoning runs in the planner (frontend `stall-price.ts`); keep them alike.
 */

import { stallArea } from '../stall-cells';

export const PRICE_TYPES = ['general', 'premium', 'marquee'] as const;
export type PriceType = (typeof PRICE_TYPES)[number];

/** One price type's rates. */
export interface PriceRates {
  /** ₹ per m² of a raw (bare) space stall. */
  bareRate: number;
  /** ₹ per m² of a shell scheme stall. */
  shellRate: number;
  /** % more for 2, 3 and 4 open sides. */
  side2Percent: number;
  side3Percent: number;
  side4Percent: number;
  /** ₹ on every stall. */
  catalogueCharge: number;
  /** ₹ for a food & beverage stall, in place of the area rate; null: the area rate. */
  fnbPrice: number | null;
}

/** A hall's rate card: General always; Premium and Marquee when they are priced apart. */
export interface PriceCard {
  general: PriceRates;
  premium: PriceRates | null;
  marquee: PriceRates | null;
}

/** What a stall's price depends on. */
export interface PricedStall {
  width: number;
  depth: number;
  /** Cells cut out of the rectangle; their floor is not sold. */
  cutCells: ReadonlyArray<readonly [number, number]>;
  /** m² the hall drawing writes on the stall; sold in place of its cells when set. */
  labelArea?: number | null;
  scheme: 'shell' | 'raw';
  openSides: readonly string[];
  isPremium: boolean;
  isMarqueeAvailable: boolean;
  isFnb: boolean;
  isBlocked: boolean;
  isActive: boolean;
}

/** A price set on the stall itself. */
export interface StallPriceOverride {
  price: number;
  note: string | null;
}

export interface StallPrice {
  /** ₹, whole rupees. */
  price: number;
  from: 'stall' | 'card';
  /** The card's price type used; null for a price set on the stall. */
  type: PriceType | null;
  /** How it was worked out, in words: "12 m² × ₹9,500 shell + 10% for 3 open sides + ₹5,000". */
  reckoning: string;
}

/** A stall that is blocked or not for sale needs no price. */
export function forSale(s: Pick<PricedStall, 'isBlocked' | 'isActive'>): boolean {
  return !s.isBlocked && s.isActive;
}

/** The card's rates a stall goes by: Premium, then Marquee, when the card has them. */
export function priceTypeOf(s: PricedStall, card: PriceCard): PriceType {
  if (s.isPremium && card.premium) return 'premium';
  if (s.isMarqueeAvailable && card.marquee) return 'marquee';
  return 'general';
}

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const metres = (n: number) => `${Math.round(n * 100) / 100}`;

/** The stall's price; null when it has none (no card, no price of its own) or is not for sale. */
export function stallPrice(
  s: PricedStall,
  card: PriceCard | null,
  own: StallPriceOverride | null | undefined,
): StallPrice | null {
  if (!forSale(s)) return null;
  if (own) {
    return {
      price: Math.round(own.price),
      from: 'stall',
      type: null,
      reckoning: own.note ? `Set on the stall: ${own.note}` : 'Set on the stall',
    };
  }
  if (!card) return null;
  const type = priceTypeOf(s, card);
  const rates = card[type]!;
  const parts: string[] = [];
  let price: number;
  if (s.isFnb && rates.fnbPrice !== null) {
    price = rates.fnbPrice;
    parts.push(`${rupees(rates.fnbPrice)} food & beverage`);
  } else {
    const area = s.labelArea ?? stallArea(s);
    const shell = s.scheme === 'shell';
    const rate = shell ? rates.shellRate : rates.bareRate;
    price = area * rate;
    parts.push(`${metres(area)} m² × ${rupees(rate)} ${shell ? 'shell' : 'bare'}`);
    const sides = new Set(s.openSides).size;
    const percent =
      sides >= 4
        ? rates.side4Percent
        : sides === 3
          ? rates.side3Percent
          : sides === 2
            ? rates.side2Percent
            : 0;
    if (percent) {
      price += (price * percent) / 100;
      parts.push(`${percent}% for ${sides} open sides`);
    }
  }
  if (rates.catalogueCharge) {
    price += rates.catalogueCharge;
    parts.push(`${rupees(rates.catalogueCharge)} catalogue`);
  }
  const label = type === 'general' ? '' : ` (${type === 'premium' ? 'Premium' : 'Marquee'} rates)`;
  return { price: Math.round(price), from: 'card', type, reckoning: parts.join(' + ') + label };
}
