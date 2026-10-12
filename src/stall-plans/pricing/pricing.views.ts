import type { PriceCard } from './stall-price';

/** The pricing of an event hall's stalls, for members who may see prices. */
export interface PlanPricingView {
  /** Null until the rate card is set. */
  card: PriceCard | null;
  /** Prices set on single stalls; the rate card prices the rest. */
  prices: Array<{ stallId: string; price: number; note: string | null }>;
  /** Whether this member may change the rate card and the stall prices. */
  canManage: boolean;
  /** Why not, in words; null when they may. */
  readOnlyReason: string | null;
}
